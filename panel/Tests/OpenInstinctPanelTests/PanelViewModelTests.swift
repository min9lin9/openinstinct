import Foundation
import Darwin
@testable import OpenInstinctPanel

@MainActor
enum PanelViewModelChecks {
    static func run() async -> [String] {
        var failures = await revisionConflictCheck()
        failures.append(contentsOf: await daemonAbsentCheck())
        failures.append(contentsOf: await stuckRefreshCheck())
        failures.append(contentsOf: await cancelledRefreshCheck())
        failures.append(contentsOf: await forcePreemptsRecoveryCheck())
        failures.append(contentsOf: await uncertainResetCheck())
        failures.append(contentsOf: await recoveryDeadlineCheck())
        failures.append(contentsOf: await silentSocketCheck())
        failures.append(contentsOf: await supersededRefreshCheck())
        failures.append(contentsOf: await stuckKickstartCheck())
        return failures
    }

    private static func revisionConflictCheck() async -> [String] {
        let initial = monitor(id: "daily", enabled: true, revision: 1)
        let refreshed = monitor(id: "daily", enabled: true, revision: 2)
        let transport = ScriptedTransport(responses: [
            .response(.monitorsList(id: "list-1", payload: MonitorsListResponsePayload(monitors: [initial]))),
            .error(ControlError(id: "toggle-1", code: .revisionConflict, message: "monitor revision conflict")),
            .response(.monitorsList(id: "list-2", payload: MonitorsListResponsePayload(monitors: [refreshed]))),
        ])
        let model = PanelViewModel(transport: transport)

        await model.refreshMonitors()
        await model.toggleMonitor(id: "daily", enabled: false)

        var failures: [String] = []
        if model.connectionState != .connected {
            failures.append("revision-conflict handling marked a healthy socket absent")
        }
        if model.monitors != [refreshed] {
            failures.append("revision conflict did not refetch current monitor state")
        }
        if model.notice != "Monitor changed elsewhere. Refreshed its current state." {
            failures.append("revision conflict did not show the inline refresh notice")
        }
        let requests = await transport.requests()
        guard requests.count == 3 else {
            failures.append("revision conflict made \(requests.count) requests instead of toggle plus refetch")
            return failures
        }
        guard case .monitorsToggle(_, let payload) = requests[1] else {
            failures.append("revision conflict test did not send a monitor toggle")
            return failures
        }
        if payload.id != "daily" || payload.enabled || payload.expectedRevision != 1 {
            failures.append("monitor toggle did not send the selected expectedRevision")
        }
        return failures
    }

    private static func daemonAbsentCheck() async -> [String] {
        let model = PanelViewModel(transport: ScriptedTransport(fails: true))
        await model.refreshStatus()
        var failures: [String] = []
        if model.connectionState != .absent {
            failures.append("socket failure did not project daemon-absent state")
        }
        if model.status != nil {
            failures.append("daemon-absent state retained stale status")
        }
        if model.connectionError == nil {
            failures.append("daemon-absent state omitted connection error")
        }
        return failures
    }

    private static func silentSocketCheck() async -> [String] {
        do {
            // A unique test-only socket accepts connections at the kernel level
            // but never negotiates. It never connects to the installed daemon.
            let socket = try SilentControlSocket()
            defer { socket.close() }
            let transport = UnixSocketTransport(socketPath: socket.path, requestTimeout: 50_000_000)
            var failures: [String] = []
            for _ in 0..<2 {
                do {
                    _ = try await transport.request(.statusGet(id: UUID().uuidString))
                    failures.append("silent control socket unexpectedly completed status.get")
                } catch ControlTransportError.timedOut {
                    // Both attempts must time out: the actor remains reusable.
                } catch {
                    failures.append("silent socket returned \(error) instead of a bounded timeout")
                }
            }
            do {
                _ = try await transport.subscribe()
                failures.append("silent control socket unexpectedly completed subscription setup")
            } catch ControlTransportError.timedOut {
                // The setup deadline must not apply to the later live stream.
            } catch {
                failures.append("silent subscription returned \(error) instead of a bounded timeout")
            }
            let cancellable = UnixSocketTransport(socketPath: socket.path, requestTimeout: 2_000_000_000)
            let request = Task { try await cancellable.request(.statusGet(id: "cancel")) }
            try await Task.sleep(nanoseconds: 20_000_000)
            let started = ContinuousClock.now
            request.cancel()
            do {
                _ = try await request.value
                failures.append("cancelled socket request returned success")
            } catch is CancellationError {
                if ContinuousClock.now - started > .seconds(1) {
                    failures.append("socket cancellation waited for the request deadline")
                }
            } catch {
                failures.append("socket cancellation surfaced as \(error) instead of cancellation")
            }
            return failures
        } catch {
            return ["could not create the silent socket regression fixture: \(error)"]
        }
    }

    private static func stuckRefreshCheck() async -> [String] {
        let transport = RecoveryTransport(holdStatus: true)
        let model = PanelViewModel(transport: transport, requestTimeout: 20_000_000)
        let started = ContinuousClock.now
        await model.refreshStatus()
        var failures: [String] = []
        if ContinuousClock.now - started > .seconds(1) {
            failures.append("stuck refresh exceeded its request deadline")
        }
        if model.connectionError?.contains("timed out") != true {
            failures.append("stuck refresh did not expose the timeout honestly")
        }
        if health(for: model).title != "Not responding" {
            failures.append("a control timeout falsely claimed the daemon was not running")
        }
        await transport.stopHoldingStatus()
        await model.refreshStatus()
        if model.connectionState != .connected || model.connectionError != nil {
            failures.append("a timed-out request prevented the next refresh from succeeding")
        }
        await transport.releaseStatus(failing: true)
        for _ in 0..<20 { await Task.yield() }
        if model.connectionState != .connected || model.connectionError != nil {
            failures.append("late failure of a timed-out refresh overwrote newer status")
        }
        return failures
    }

    private static func cancelledRefreshCheck() async -> [String] {
        let transport = RecoveryTransport()
        let model = PanelViewModel(transport: transport, requestTimeout: 2_000_000_000)
        await model.refreshStatus()
        await transport.startHoldingStatus()
        let refresh = Task { await model.refreshStatus() }
        guard await eventually({ await transport.pendingStatusCount() == 1 }) else {
            refresh.cancel()
            await transport.releaseStatus(failing: true)
            return ["cancelled refresh fixture never received the status request"]
        }
        let started = ContinuousClock.now
        refresh.cancel()
        await refresh.value
        var failures: [String] = []
        if ContinuousClock.now - started > .seconds(1) {
            failures.append("refresh cancellation waited for an uncooperative transport")
        }
        if model.connectionState != .connected || model.connectionError != nil {
            failures.append("closing the popover marked a healthy daemon absent")
        }
        await transport.releaseStatus(failing: true)
        return failures
    }

    private static func supersededRefreshCheck() async -> [String] {
        let transport = RecoveryTransport(holdStatus: true)
        let kickstarts = KickstartRecorder()
        let model = PanelViewModel(
            transport: transport,
            daemonKickstart: { await kickstarts.record() },
            requestTimeout: 2_000_000_000
        )
        var failures: [String] = []
        for recover in [false, true] {
            await transport.startHoldingStatus()
            let old = Task { await model.refreshStatus() }
            guard await eventually({ await transport.pendingStatusCount() == 1 }) else {
                old.cancel()
                await transport.releaseAll()
                await old.value
                return ["superseded refresh fixture did not receive its request"]
            }
            await transport.stopHoldingStatus()
            if recover { await model.forceRestartAndReset() }
            else { await model.refreshStatus() }
            let notice = model.notice
            await transport.releaseStatus(failing: true)
            await old.value
            if model.connectionState != .connected || model.connectionError != nil || model.notice != notice {
                failures.append("older refresh overwrote \(recover ? "force recovery" : "newer refresh") state")
            }
            if recover && model.status?.session.mainSessionId != "fresh" {
                failures.append("older refresh replaced the fresh conversation status")
            }
        }
        return failures
    }

    private static func stuckKickstartCheck() async -> [String] {
        let transport = RecoveryTransport()
        let kickstarts = KickstartRecorder(hold: true)
        let model = PanelViewModel(
            transport: transport,
            daemonKickstart: { await kickstarts.record() },
            requestTimeout: 50_000_000
        )
        await model.forceRestartAndReset()
        var failures: [String] = []
        if model.recoveryInProgress || model.notice?.contains("timed out") != true {
            failures.append("stuck kickstart kept recovery busy or hid the timeout")
        }
        await kickstarts.release()
        for _ in 0..<20 { await Task.yield() }
        if await transport.resetCount() != 0 {
            failures.append("expired kickstart continued into a destructive reset")
        }
        return failures
    }

    private static func forcePreemptsRecoveryCheck() async -> [String] {
        let transport = RecoveryTransport(holdRestart: true, holdReset: true)
        let kickstarts = KickstartRecorder()
        let model = PanelViewModel(
            transport: transport,
            daemonKickstart: { await kickstarts.record() },
            requestTimeout: 2_000_000_000
        )
        await model.refreshStatus()
        let normal = Task { await model.restartDaemon() }
        guard await eventually({ await transport.restartCount() == 1 }) else {
            await transport.releaseAll()
            await normal.value
            return ["normal recovery fixture did not receive daemon.restart"]
        }
        let force = Task { await model.forceRestartAndReset() }
        guard await eventually({ await transport.resetCount() == 1 }) else {
            await transport.releaseAll()
            await force.value
            await normal.value
            return ["force was ignored or waited for the hung normal recovery"]
        }
        let duplicate = Task { await model.forceRestartAndReset() }
        for _ in 0..<20 { await Task.yield() }
        let workingNotice = model.notice
        // Complete the superseded request while the force reset is still held.
        await transport.releaseRestart()
        await normal.value
        var failures: [String] = []
        if !model.recoveryInProgress || model.notice != workingNotice {
            failures.append("superseded recovery overwrote the newer recovery's progress or notice")
        }
        if await kickstarts.count() != 1 {
            failures.append("force did not use exactly one out-of-band kickstart")
        }
        if await transport.resetCount() != 1 {
            failures.append("repeated force clicks issued duplicate destructive resets")
        }
        await transport.releaseAll()
        await force.value
        await duplicate.value
        if model.recoveryInProgress || model.status?.session.mainSessionId != "fresh" {
            failures.append("force recovery did not finish with the fresh session")
        }
        if model.notice != "Fresh conversation started. Your memory and settings are safe." {
            failures.append("late normal recovery completion replaced force recovery success")
        }
        if await transport.restartCount() != 1 {
            // The force path must never re-enter the hung daemon.restart route.
            failures.append("force recovery retried daemon.restart")
        }
        let finalKickstarts = await kickstarts.count()
        let finalResets = await transport.resetCount()
        if finalKickstarts != 1 || finalResets != 1 {
            failures.append("force completion scheduled an extra kickstart or reset")
        }
        return failures
    }

    private static func uncertainResetCheck() async -> [String] {
        let transport = RecoveryTransport(holdReset: true)
        let kickstarts = KickstartRecorder()
        let model = PanelViewModel(
            transport: transport,
            daemonKickstart: { await kickstarts.record() },
            requestTimeout: 20_000_000
        )
        await model.forceRestartAndReset()
        var failures: [String] = []
        if model.recoveryInProgress || model.notice?.contains("no reset was retried") != true {
            failures.append("uncertain reset did not finish with an honest non-retry notice")
        }
        if await transport.resetCount() != 1 || model.notice?.contains("timed out") != true {
            failures.append("ambiguous reset timeout was retried or hidden")
        }
        let notice = model.notice
        await transport.releaseAll()
        for _ in 0..<20 { await Task.yield() }
        if model.notice != notice {
            failures.append("late reset acknowledgement changed the reported recovery outcome")
        }
        return failures
    }

    private static func recoveryDeadlineCheck() async -> [String] {
        let transport = RecoveryTransport(holdStatus: true)
        let kickstarts = KickstartRecorder()
        let model = PanelViewModel(
            transport: transport,
            daemonKickstart: { await kickstarts.record() },
            requestTimeout: 2_000_000_000,
            recoveryTimeout: 20_000_000
        )
        await model.forceRestartAndReset()
        var failures: [String] = []
        if model.recoveryInProgress || model.notice?.contains("timed out") != true {
            failures.append("recovery's overall deadline did not release the UI with a timeout")
        }
        await transport.releaseAll()
        for _ in 0..<20 { await Task.yield() }
        if await transport.resetCount() != 0 {
            failures.append("expired recovery continued into a destructive reset")
        }
        return failures
    }

    private static func eventually(_ predicate: @escaping @Sendable () async -> Bool) async -> Bool {
        for _ in 0..<500 {
            if await predicate() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return false
    }

    private static func monitor(id: String, enabled: Bool, revision: Int) -> Monitor {
        Monitor(
            id: id,
            name: "Daily briefing",
            trigger: .cron(expression: "30 8 * * 1-5"),
            instruction: "Summarize priorities.",
            eventTypes: ["cron"],
            burstPolicy: "coalesce",
            tz: "Asia/Seoul",
            timeoutSec: 2700,
            enabled: enabled,
            revision: revision,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
        )
    }
}

private enum StubTransportError: Error, LocalizedError, Sendable {
    case unavailable

    var errorDescription: String? {
        "socket unavailable"
    }
}

/// No accept loop is needed: connected clients can send into the backlog, but
/// no server code ever reads or replies. Four requests fit in the backlog.
private final class SilentControlSocket {
    let path = "/tmp/oi-panel-\(UUID().uuidString).sock"
    private var descriptor: Int32 = -1

    init() throws {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw StubTransportError.unavailable }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = path.utf8CString.map { UInt8(bitPattern: $0) }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, Darwin.listen(fd, 8) == 0 else {
            Darwin.close(fd)
            if bound == 0 { Darwin.unlink(path) }
            throw StubTransportError.unavailable
        }
        descriptor = fd
    }

    func close() {
        guard descriptor >= 0 else { return }
        Darwin.close(descriptor)
        descriptor = -1
        Darwin.unlink(path)
    }

    deinit { close() }
}

private actor KickstartRecorder {
    private var calls = 0
    private var hold: Bool
    private var waiter: CheckedContinuation<Void, Never>?
    init(hold: Bool = false) { self.hold = hold }
    func record() async {
        calls += 1
        if hold { await withCheckedContinuation { waiter = $0 } }
    }
    func release() {
        hold = false
        waiter?.resume()
        waiter = nil
    }
    func count() -> Int { calls }
}

/// Deliberately ignores cancellation until explicitly released. This proves a
/// deadline and newer recovery do not rely on cooperative transport callbacks.
private actor RecoveryTransport: ControlTransport {
    private var holdStatus: Bool
    private var holdRestart: Bool
    private var holdReset: Bool
    private var statusWaiters: [CheckedContinuation<ControlFrame, Error>] = []
    private var restartWaiters: [CheckedContinuation<ControlFrame, Error>] = []
    private var resetWaiters: [CheckedContinuation<ControlFrame, Error>] = []
    private var restarts = 0
    private var resets = 0
    private var sessionID = "main"

    init(holdStatus: Bool = false, holdRestart: Bool = false, holdReset: Bool = false) {
        self.holdStatus = holdStatus
        self.holdRestart = holdRestart
        self.holdReset = holdReset
    }

    func request(_ request: ControlRequest) async throws -> ControlFrame {
        switch request {
        case .statusGet:
            if holdStatus {
                return try await withCheckedThrowingContinuation { statusWaiters.append($0) }
            }
            return statusFrame()
        case .daemonRestart:
            restarts += 1
            if holdRestart {
                return try await withCheckedThrowingContinuation { restartWaiters.append($0) }
            }
            return restartFrame()
        case .sessionReset:
            resets += 1
            sessionID = "fresh"
            if holdReset {
                return try await withCheckedThrowingContinuation { resetWaiters.append($0) }
            }
            return resetFrame()
        default:
            throw StubTransportError.unavailable
        }
    }

    func subscribe() async throws -> ChatSubscription { throw StubTransportError.unavailable }
    func pendingStatusCount() -> Int { statusWaiters.count }
    func restartCount() -> Int { restarts }
    func resetCount() -> Int { resets }
    func startHoldingStatus() { holdStatus = true }
    func stopHoldingStatus() { holdStatus = false }

    func releaseStatus(failing: Bool = false) {
        holdStatus = false
        let waiters = statusWaiters
        statusWaiters = []
        for waiter in waiters {
            if failing { waiter.resume(throwing: StubTransportError.unavailable) }
            else { waiter.resume(returning: statusFrame()) }
        }
    }

    func releaseRestart() {
        holdRestart = false
        let waiters = restartWaiters
        restartWaiters = []
        for waiter in waiters { waiter.resume(returning: restartFrame()) }
    }

    func releaseAll() {
        releaseStatus()
        releaseRestart()
        holdReset = false
        let waiters = resetWaiters
        resetWaiters = []
        for waiter in waiters { waiter.resume(returning: resetFrame()) }
    }

    private func statusFrame() -> ControlFrame {
        .response(.status(id: "status", payload: StatusResponsePayload(
            bootstrap: BootstrapStatus(state: .running, remediation: "", probes: [:]),
            session: SessionStatus(state: .active, mainSessionId: sessionID, mainSessionFilePresent: true, paused: false),
            activeChildren: [], monitors: [], settings: SettingsStatus(),
            imessage: ImessageLaneStatus(state: .detached)
        )))
    }

    private func restartFrame() -> ControlFrame {
        .response(.daemonRestart(id: "restart", payload: DaemonRestartResponsePayload(restarting: true)))
    }

    private func resetFrame() -> ControlFrame {
        .response(.sessionReset(id: "reset", payload: SessionResetResponsePayload(reset: true, sessionId: "fresh")))
    }
}

private actor ScriptedTransport: ControlTransport {
    private var queuedResponses: [ControlFrame]
    private var recordedRequests: [ControlRequest] = []
    private let fails: Bool
    private let subscribeAck: ControlFrame?
    private let subscribeEvents: [ControlEvent]

    init(
        responses: [ControlFrame] = [],
        fails: Bool = false,
        subscribeAck: ControlFrame? = nil,
        subscribeEvents: [ControlEvent] = []
    ) {
        queuedResponses = responses
        self.fails = fails
        self.subscribeAck = subscribeAck
        self.subscribeEvents = subscribeEvents
    }

    func request(_ request: ControlRequest) async throws -> ControlFrame {
        recordedRequests.append(request)
        if fails {
            throw StubTransportError.unavailable
        }
        guard !queuedResponses.isEmpty else {
            throw StubTransportError.unavailable
        }
        return queuedResponses.removeFirst()
    }

    func subscribe() async throws -> ChatSubscription {
        if fails {
            throw StubTransportError.unavailable
        }
        // Mirrors the real transport: an error in place of the ack throws, and
        // the stream is only handed back once the ack has been seen.
        if let ack = subscribeAck, case .error = ack {
            throw StubTransportError.unavailable
        }
        let events = subscribeEvents
        let stream = AsyncThrowingStream<ControlEvent, Error> { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
        return ChatSubscription(events: stream, cancel: {})
    }

    func requests() -> [ControlRequest] {
        recordedRequests
    }
}

/// `FrameReader` owns the byte-level contract the chat subscription depends on:
/// a burst of coalesced event frames must not lose all but the first.
enum FrameReaderChecks {
    static func run() -> [String] {
        var failures: [String] = []
        failures.append(contentsOf: splitAcrossChunks())
        failures.append(contentsOf: coalescedInOneChunk())
        failures.append(contentsOf: carriageReturnLineEndings())
        failures.append(contentsOf: incompleteAtEOF())
        failures.append(contentsOf: oversizeGuard())
        return failures
    }

    private static func line(_ text: String) -> Data {
        Data(text.utf8)
    }

    private static func eventFrame(seq: Int) -> String {
        "{\"type\":\"event\",\"topic\":\"chat.message\",\"payload\":{\"seq\":\(seq),\"role\":\"assistant\",\"text\":\"t\(seq)\"}}"
    }

    private static func splitAcrossChunks() -> [String] {
        var reader = FrameReader()
        let whole = eventFrame(seq: 1) + "\n"
        let cut = whole.index(whole.startIndex, offsetBy: 20)
        reader.append(line(String(whole[whole.startIndex..<cut])))
        do {
            if try reader.nextFrame() != nil {
                return ["FrameReader yielded a frame from a partial chunk"]
            }
            reader.append(line(String(whole[cut...])))
            guard let frame = try reader.nextFrame() else {
                return ["FrameReader did not reassemble a frame split across chunks"]
            }
            guard case .event(.chatMessage(let payload)) = frame, payload.seq == 1 else {
                return ["FrameReader reassembled the wrong frame"]
            }
            return []
        } catch {
            return ["FrameReader threw on a split frame: \(error)"]
        }
    }

    private static func coalescedInOneChunk() -> [String] {
        var reader = FrameReader()
        reader.append(line(eventFrame(seq: 1) + "\n" + eventFrame(seq: 2) + "\n"))
        do {
            var seqs: [Int] = []
            while let frame = try reader.nextFrame() {
                if case .event(.chatMessage(let payload)) = frame, let seq = payload.seq {
                    seqs.append(seq)
                }
            }
            if seqs != [1, 2] {
                return ["FrameReader dropped coalesced frames, got \(seqs) instead of [1, 2]"]
            }
            return []
        } catch {
            return ["FrameReader threw on coalesced frames: \(error)"]
        }
    }

    private static func carriageReturnLineEndings() -> [String] {
        var reader = FrameReader()
        reader.append(line(eventFrame(seq: 7) + "\r\n"))
        do {
            guard let frame = try reader.nextFrame() else {
                return ["FrameReader did not yield a CRLF-terminated frame"]
            }
            guard case .event(.chatMessage(let payload)) = frame, payload.seq == 7 else {
                return ["FrameReader mis-decoded a CRLF-terminated frame"]
            }
            return []
        } catch {
            return ["FrameReader threw on a CRLF frame: \(error)"]
        }
    }

    private static func incompleteAtEOF() -> [String] {
        var reader = FrameReader()
        reader.append(line("{\"type\":\"event\""))
        do {
            _ = try reader.nextFrame()
        } catch {
            return ["FrameReader should buffer, not throw, before EOF: \(error)"]
        }
        do {
            try reader.assertDrainedAtEOF()
            return ["FrameReader accepted a truncated frame at EOF"]
        } catch {
            return []
        }
    }

    private static func oversizeGuard() -> [String] {
        var reader = FrameReader(maxFrameBytes: 64)
        reader.append(Data(repeating: 0x41, count: 128))
        do {
            _ = try reader.nextFrame()
            return ["FrameReader accepted an oversized unterminated frame"]
        } catch {
            return []
        }
    }
}

/// The subscription contract the chat view model relies on: `subscribe()` is
/// ack-gated, pre-ack events survive, an error instead of the ack throws, and
/// cancelling ends the stream.
enum ChatSubscriptionChecks {
    static func run() async -> [String] {
        var failures: [String] = []

        let queued: [ControlEvent] = [
            .chatMessage(ChatMessagePayload(role: "assistant", text: "before ack", seq: 1)),
            .chatMessage(ChatMessagePayload(role: "assistant", text: "after ack", seq: 2)),
        ]
        let transport = ScriptedTransport(
            subscribeAck: .response(.chatSubscribe(id: "sub-1", payload: ChatSubscribeResponsePayload(subscribed: true))),
            subscribeEvents: queued
        )
        do {
            let subscription = try await transport.subscribe()
            var seqs: [Int] = []
            for try await event in subscription.events {
                if case .chatMessage(let payload) = event, let seq = payload.seq {
                    seqs.append(seq)
                }
            }
            if seqs != [1, 2] {
                failures.append("subscription lost pre-ack events, got \(seqs) instead of [1, 2]")
            }
        } catch {
            failures.append("subscribe threw on a successful ack: \(error)")
        }

        let failing = ScriptedTransport(subscribeAck: .error(ControlError(id: "sub-1", code: .internalError, message: "nope")))
        do {
            _ = try await failing.subscribe()
            failures.append("subscribe returned a subscription despite an error frame in place of the ack")
        } catch {
            // expected
        }

        let cancelling = ScriptedTransport(
            subscribeAck: .response(.chatSubscribe(id: "sub-2", payload: ChatSubscribeResponsePayload(subscribed: true)))
        )
        do {
            let subscription = try await cancelling.subscribe()
            subscription.cancel()
            for try await _ in subscription.events {
                // Draining a cancelled subscription must terminate, not hang.
            }
        } catch {
            failures.append("cancelled subscription surfaced an unexpected error: \(error)")
        }

        return failures
    }
}
