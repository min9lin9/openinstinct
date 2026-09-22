import Combine
import Darwin
import Foundation

public enum DaemonConnectionState: Equatable, Sendable {
    case loading
    case connected
    case absent
}

@MainActor
public final class PanelViewModel: ObservableObject {
    @Published public private(set) var connectionState: DaemonConnectionState = .loading
    @Published public private(set) var status: StatusResponsePayload?
    @Published public private(set) var monitors: [Monitor] = []
    @Published public private(set) var notice: String?
    @Published public private(set) var connectionError: String?
    @Published public private(set) var togglingMonitorIDs: Set<String> = []
    @Published public private(set) var runningMonitorIDs: Set<String> = []
    @Published public private(set) var recoveryInProgress = false
    /// Bumped after a forced `models.list` refresh so open windows can re-pull the list.
    @Published public private(set) var modelsRefreshedAt: Date?

    private let transport: any ControlTransport
    private let daemonKickstart: @Sendable () async throws -> Void
    private let requestTimeout: UInt64
    private let recoveryTimeout: UInt64
    private var recoveryGeneration = 0
    private var recoveryTask: Task<Void, Never>?
    private var forceRecoveryInProgress = false
    private var statusRefreshGeneration = 0
    private var monitorsRefreshGeneration = 0
    private var modelsRefreshGeneration = 0

    public init(
        transport: any ControlTransport = UnixSocketTransport(),
        daemonKickstart: (@Sendable () async throws -> Void)? = nil,
        requestTimeout: UInt64 = 8_000_000_000,
        recoveryTimeout: UInt64 = 35_000_000_000
    ) {
        self.transport = transport
        self.daemonKickstart = daemonKickstart ?? { try await PanelViewModel.kickstartDaemon() }
        self.requestTimeout = requestTimeout
        self.recoveryTimeout = recoveryTimeout
    }

    /// Turns a provider/model id into a short label suitable for the status popover.
    /// The exact id remains available in Details so this is only a readability aid.
    public nonisolated static func modelDisplayName(_ modelID: String) -> String {
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
        guard let providerPart = parts.first else { return trimmed }
        guard parts.count == 2 else { return prettyModelWords(String(providerPart)) }
        let provider = prettyProviderName(String(providerPart))
        let model = prettyModelWords(String(parts[1]))
        return provider.isEmpty ? model : "\(provider) · \(model)"
    }

    private nonisolated static func prettyProviderName(_ raw: String) -> String {
        let normalized = raw.lowercased()
        if normalized.contains("anthropic") { return "Anthropic" }
        if normalized.contains("openai") { return "OpenAI" }
        if normalized.contains("google") || normalized.contains("gemini") { return "Google" }
        if normalized.contains("mistral") { return "Mistral" }
        return prettyModelWords(raw)
    }

    private nonisolated static func prettyModelWords(_ raw: String) -> String {
        raw.replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { String($0).capitalized }
            .joined(separator: " ")
    }

    public func refresh() async {
        let generation = recoveryGeneration
        await refreshStatus()
        guard !Task.isCancelled, generation == recoveryGeneration, connectionState == .connected else {
            return
        }
        await refreshMonitors()
    }

    /// The panel's reload button: everything `refresh()` does plus a forced model-list reload.
    public func reload() async {
        let generation = recoveryGeneration
        await refresh()
        guard !Task.isCancelled, generation == recoveryGeneration, connectionState == .connected else {
            return
        }
        await refreshModels()
    }

    /// Forces the daemon to re-run `gjc --list-models`, dropping its cached list and restarting its TTL.
    public func refreshModels() async {
        modelsRefreshGeneration += 1
        let generation = modelsRefreshGeneration
        do {
            let frame = try await requestControl(.modelsList(id: requestID(), payload: ModelsListPayload(refresh: true)))
            guard generation == modelsRefreshGeneration else { return }
            switch frame {
            case .response(.modelsList):
                modelsRefreshedAt = Date()
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            guard generation == modelsRefreshGeneration else { return }
            markDaemonAbsent(error)
        }
    }

    public func refreshStatus() async {
        statusRefreshGeneration += 1
        let generation = statusRefreshGeneration
        do {
            let frame = try await requestControl(.statusGet(id: requestID()))
            guard generation == statusRefreshGeneration else { return }
            guard case .response(.status(_, let payload)) = frame else {
                throw PanelModelError.unexpectedFrame
            }
            status = payload
            connectionState = .connected
            connectionError = nil
        } catch {
            guard generation == statusRefreshGeneration else { return }
            markDaemonAbsent(error)
        }
    }

    public func refreshMonitors() async {
        monitorsRefreshGeneration += 1
        let generation = monitorsRefreshGeneration
        do {
            let frame = try await requestControl(.monitorsList(id: requestID()))
            guard generation == monitorsRefreshGeneration else { return }
            guard case .response(.monitorsList(_, let payload)) = frame else {
                throw PanelModelError.unexpectedFrame
            }
            monitors = payload.monitors
            connectionState = .connected
            connectionError = nil
        } catch {
            guard generation == monitorsRefreshGeneration else { return }
            markDaemonAbsent(error)
        }
    }

    public func openBrowserProfile() async {
        do {
            let frame = try await requestControl(.browserOpen(id: requestID()))
            switch frame {
            case .response(.browserOpen): notice = "Gajae's browser opened. Sign into the sites you want it to use, then just close the window."
            case .error(let error): notice = error.message
            default: throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func resetSession() async {
        do {
            let frame = try await requestControl(.sessionReset(id: requestID()))
            switch frame {
            case .response(.sessionReset): notice = "Fresh conversation started. Memory is kept."; await refresh()
            case .error(let error): notice = error.message
            default: throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func setFastMode(_ enabled: Bool) async {
        guard status?.session.fastModeAvailable == true else { return }
        do {
            let frame = try await requestControl(.settingsSet(
                id: requestID(),
                payload: SettingsSetPayload(patch: ["fastMode": .bool(enabled)])
            ))
            switch frame {
            case .response(.settingsSet):
                notice = enabled ? "Fast mode is on." : "Fast mode is off."
                await refreshStatus()
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            guard !(error is CancellationError), !Task.isCancelled else { return }
            notice = "Fast mode could not be changed. Gajae will keep using normal speed."
            await refreshStatus()
        }
    }

    /// Restarts the daemon, using launchd directly when the control socket cannot answer.
    public func restartDaemon() async {
        await runRecovery(resetConversation: false)
    }

    /// Starts a fresh conversation without touching memory, settings, or credentials.
    public func forceRestartAndReset() async {
        await runRecovery(resetConversation: true)
    }

    private func runRecovery(resetConversation: Bool) async {
        if let recoveryTask {
            // Repeated confirmed force clicks join the same reset, never send
            // a second destructive request with an uncertain first outcome.
            if forceRecoveryInProgress || !resetConversation {
                await recoveryTask.value
                return
            }
            recoveryTask.cancel()
        }
        recoveryGeneration += 1
        let generation = recoveryGeneration
        recoveryInProgress = true
        forceRecoveryInProgress = resetConversation
        notice = resetConversation ? "Starting a fresh conversation safely…" : "Restarting Gajae…"
        let task = Task {
            do {
                try await boundedControlOperation(timeout: recoveryTimeout) {
                    try await self.performRecovery(resetConversation: resetConversation)
                }
                guard generation == recoveryGeneration else { return }
                notice = resetConversation
                    ? "Fresh conversation started. Your memory and settings are safe."
                    : "Gajae restarted. Your conversation and settings are unchanged."
            } catch {
                guard generation == recoveryGeneration else { return }
                notice = resetConversation
                    ? "Gajae could not confirm the fresh start: \(error.localizedDescription) The conversation may have reset; no reset was retried. Memory and settings are safe."
                    : "Gajae could not restart automatically: \(error.localizedDescription) Try Force Restart & Reset."
            }
            guard generation == recoveryGeneration else { return }
            recoveryInProgress = false
            forceRecoveryInProgress = false
            recoveryTask = nil
        }
        recoveryTask = task
        await task.value
    }

    private func performRecovery(resetConversation: Bool) async throws {
        try Task.checkCancellation()
        if resetConversation {
            // Escape the control socket first, even if its last status was healthy.
            try await kickstartAndReconnect()
            try Task.checkCancellation()
            try await requestSessionReset()
        } else {
            try await restartDaemonReliably()
        }
        try Task.checkCancellation()
        await refreshStatus()
        try Task.checkCancellation()
        guard connectionState == .connected,
              status?.bootstrap.state == .running,
              status?.session.state == .active else {
            throw RecoveryError.daemonUnavailable
        }
    }

    private func requestControl(_ request: ControlRequest) async throws -> ControlFrame {
        let generation = recoveryGeneration
        do {
            let frame = try await boundedControlOperation(timeout: requestTimeout) { [transport] in
                try await transport.request(request)
            }
            try Task.checkCancellation()
            guard generation == recoveryGeneration else { throw CancellationError() }
            return frame
        } catch {
            guard generation == recoveryGeneration, !Task.isCancelled else { throw CancellationError() }
            throw error
        }
    }

    private func requestSessionReset() async throws {
        let frame = try await requestControl(.sessionReset(id: requestID()))
        switch frame {
        case .response(.sessionReset(_, let payload)) where payload.reset:
            return
        case .response(.sessionReset), .error:
            throw RecoveryError.controlUnavailable
        default:
            throw PanelModelError.unexpectedFrame
        }
    }

    private func requestDaemonRestart() async throws {
        let frame = try await requestControl(.daemonRestart(id: requestID()))
        switch frame {
        case .response(.daemonRestart(_, let payload)) where payload.restarting:
            return
        case .response(.daemonRestart):
            throw RecoveryError.controlUnavailable
        case .error:
            throw RecoveryError.controlUnavailable
        default:
            throw PanelModelError.unexpectedFrame
        }
    }

    private func restartDaemonReliably() async throws {
        do {
            try await requestDaemonRestart()
            try await waitForRestartCycle()
        } catch {
            try Task.checkCancellation()
            try await kickstartAndReconnect()
        }
    }

    private func kickstartAndReconnect() async throws {
        try Task.checkCancellation()
        try await boundedControlOperation(timeout: requestTimeout, operation: daemonKickstart)
        try Task.checkCancellation()
        try await waitForDaemon()
    }

    private func waitForDaemon() async throws {
        for attempt in 0..<50 {
            if attempt > 0 {
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            await refreshStatus()
            try Task.checkCancellation()
            if connectionState == .connected,
               status?.bootstrap.state == .running,
               status?.session.state == .active {
                return
            }
        }
        throw RecoveryError.daemonUnavailable
    }

    private func waitForRestartCycle() async throws {
        var crossedRestartBoundary = false
        for _ in 0..<50 {
            try await Task.sleep(nanoseconds: 300_000_000)
            await refreshStatus()
            try Task.checkCancellation()
            let ready = connectionState == .connected
                && status?.bootstrap.state == .running
                && status?.session.state == .active
            if !ready {
                crossedRestartBoundary = true
            } else if crossedRestartBoundary {
                return
            }
        }
        throw RecoveryError.daemonUnavailable
    }

    public func reloadPersona() async {
        do {
            let frame = try await requestControl(.sessionReload(id: requestID()))
            switch frame {
            case .response(.sessionReload(_, let payload)):
                notice = "Persona reloaded (soul v\(payload.soulVersion))."
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func deleteMonitor(id: String) async {
        let generation = recoveryGeneration
        guard let monitor = monitors.first(where: { $0.id == id }) else {
            return
        }
        togglingMonitorIDs.insert(id)
        defer { togglingMonitorIDs.remove(id) }
        do {
            let request = ControlRequest.monitorsDelete(
                id: requestID(),
                payload: MonitorDeletePayload(id: id, expectedRevision: monitor.revision)
            )
            let frame = try await requestControl(request)
            switch frame {
            case .response(.monitorsDelete(_, let payload)) where payload.deleted:
                monitors.removeAll { $0.id == id }
                notice = nil
            case .error(let error) where error.code == .revisionConflict:
                await refreshMonitors()
                if generation == recoveryGeneration, !Task.isCancelled, connectionState == .connected {
                    notice = "Monitor changed elsewhere. Refreshed its current state."
                }
            case .error(let error) where error.code == .monitorBusy:
                notice = "It's in the middle of a run. Try again in a minute."
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func toggleMonitor(id: String, enabled: Bool) async {
        let generation = recoveryGeneration
        guard let monitor = monitors.first(where: { $0.id == id }) else {
            return
        }
        togglingMonitorIDs.insert(id)
        defer { togglingMonitorIDs.remove(id) }

        do {
            let request = ControlRequest.monitorsToggle(
                id: requestID(),
                payload: MonitorTogglePayload(id: id, enabled: enabled, expectedRevision: monitor.revision)
            )
            let frame = try await requestControl(request)
            switch frame {
            case .response(.monitorsToggle(_, let payload)):
                replaceMonitor(payload.monitor)
                notice = nil
            case .error(let error) where error.code == .revisionConflict:
                await refreshMonitors()
                if generation == recoveryGeneration, !Task.isCancelled, connectionState == .connected {
                    notice = "Monitor changed elsewhere. Refreshed its current state."
                }
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    /// Fires a monitor now, whatever its schedule says. Works for disabled and
    /// built-in monitors too: an explicit request outranks the switch.
    public func runMonitor(id: String) async {
        guard let monitor = monitors.first(where: { $0.id == id }) else { return }
        runningMonitorIDs.insert(id)
        defer { runningMonitorIDs.remove(id) }
        do {
            let request = ControlRequest.monitorsRun(id: requestID(), payload: MonitorRunPayload(id: id))
            switch try await requestControl(request) {
            case .response(.monitorsRun(_, let payload)):
                notice = payload.dispatched
                    ? "Running \"\(monitor.name)\" now."
                    : (payload.reason.map { "Did not run \"\(monitor.name)\": \($0)." } ?? "Did not run \"\(monitor.name)\".")
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func setPaused(_ paused: Bool) async {
        do {
            let request: ControlRequest = paused
                ? .daemonPause(id: requestID())
                : .daemonResume(id: requestID())
            let frame = try await requestControl(request)
            guard case .response(.daemonPause(_, let payload)) = frame, payload.paused == paused else {
                throw PanelModelError.unexpectedFrame
            }
            await refreshStatus()
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func clearNotice() {
        notice = nil
    }

    private func replaceMonitor(_ monitor: Monitor) {
        guard let index = monitors.firstIndex(where: { $0.id == monitor.id }) else {
            monitors.append(monitor)
            return
        }
        monitors[index] = monitor
    }

    private func markDaemonAbsent(_ error: Error) {
        guard !(error is CancellationError), !Task.isCancelled else { return }
        // A transport failure means "not responding", not proof of a stopped daemon.
        // An undecodable frame may mean a newer daemon: keep the last good state.
        if error is PanelModelError || error is DecodingError || error is ControlCodecError {
            connectionError = "Gajae is running but this panel is out of date. Reinstall to update it."
            if status == nil { connectionState = .absent }
            return
        }
        connectionState = .absent
        status = nil
        monitors = []
        connectionError = "\(error.localizedDescription) Try refreshing again, Restart Gajae, or Force Restart & Reset."
    }

    nonisolated static func kickstartDaemon() async throws {
        let command = LaunchctlKickstart()
        let result = await withTaskCancellationHandler {
            await Task.detached(priority: .userInitiated) { command.run() }.value
        } onCancel: {
            command.cancel()
        }
        try Task.checkCancellation()
        guard result == 0 else { throw RecoveryError.kickstartFailed }
    }

    /// Synchronizes cancellation with process launch, including cancellation
    /// before the detached worker starts. Only this launchctl child is killed.
    private final class LaunchctlKickstart: @unchecked Sendable {
        private let lock = NSLock()
        private let process = Process()
        private let exited = DispatchSemaphore(value: 0)
        private var cancelled = false

        func run() -> Int32 {
            lock.lock()
            guard !cancelled else {
                lock.unlock()
                return -1
            }
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["kickstart", "-k", "gui/\(getuid())/co.openinstinct.daemon"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [exited] _ in exited.signal() }
            do {
                try process.run()
            } catch {
                lock.unlock()
                return -1
            }
            lock.unlock()
            guard exited.wait(timeout: .now() + 5) == .success else {
                cancel()
                return -1
            }
            lock.lock()
            defer { lock.unlock() }
            return cancelled || process.isRunning ? -1 : process.terminationStatus
        }

        func cancel() {
            lock.lock()
            defer { lock.unlock() }
            cancelled = true
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            exited.signal()
        }
    }

    private func requestID() -> String {
        UUID().uuidString.lowercased()
    }
}

private enum RecoveryError: LocalizedError {
    case controlUnavailable
    case daemonUnavailable
    case kickstartFailed

    var errorDescription: String? {
        switch self {
        case .controlUnavailable: return "The daemon did not acknowledge the recovery request."
        case .daemonUnavailable: return "The daemon did not become ready before the recovery deadline."
        case .kickstartFailed: return "launchctl failed or did not finish within five seconds."
        }
    }
}

private enum PanelModelError: LocalizedError {
    case unexpectedFrame

    var errorDescription: String? {
        switch self {
        case .unexpectedFrame:
            return "The daemon returned an unexpected control response."
        }
    }
}
