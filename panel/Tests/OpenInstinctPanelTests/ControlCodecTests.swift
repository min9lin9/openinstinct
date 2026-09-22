import Foundation
@testable import OpenInstinctPanel

private enum Decoded<T> {
    case ok(T)
    case bad(String)
}

enum ControlCodecChecks {
    static func run() -> [String] {
        var failures: [String] = []
        failures.append(contentsOf: roundTripFailures())
        failures.append(contentsOf: negotiatedStatusFailures())
        failures.append(contentsOf: statusFixtureFailures())
        failures.append(contentsOf: chatFixtureFailures())
        failures.append(contentsOf: crossDecodeFailures())
        return failures
    }

    /// Every bundled fixture must survive decode -> encode unchanged. The status
    /// payload has a hand-written `encode(to:)`, so a field missing there (for
    /// example the iMessage lane block) shows up here first.
    private static func roundTripFailures() -> [String] {
        var failures: [String] = []
        do {
            let fixtures = try fixtureURLs()
            if fixtures.isEmpty {
                failures.append("no bundled golden control fixtures were found")
            }
            for fixture in fixtures {
                let source = try Data(contentsOf: fixture)
                let frame = try ControlCodec.decode(source)
                let encoded = try ControlCodec.encode(frame)
                let sourceObject = try JSONSerialization.jsonObject(with: source)
                let encodedObject = try JSONSerialization.jsonObject(with: encoded)
                if !(sourceObject as AnyObject).isEqual(encodedObject) {
                    failures.append("round trip changed \(fixture.lastPathComponent)")
                }
            }
        } catch {
            failures.append("golden fixture round trip threw: \(error.localizedDescription)")
        }
        return failures
    }

    /// The daemon's complete capability advertisement must not block status refresh.
    private static func negotiatedStatusFailures() -> [String] {
        let expectedCapabilities = [
            "status.get", "monitors.list", "monitors.toggle", "monitors.run", "monitors.delete",
            "daemon.pause", "daemon.resume", "session.compact", "session.compact.status",
            "session.reload", "session.reset", "session.notify", "chat.send", "chat.history",
            "chat.subscribe", "chat.activity", "assistant.notifications.list",
            "assistant.notifications.ack", "assistant.notifications.rendered", "settings.get",
            "settings.set", "models.list", "accounts.list", "accounts.login", "accounts.logout",
            "accounts.login.finish", "accounts.providers", "accounts.discover", "accounts.adopt",
            "providers.custom", "daemon.restart", "browser.open", "maintenance.run",
            "memory.backfillCaptures", "peers.list", "peers.upsert", "peers.revoke"
        ]
        var failures: [String] = []
        do {
            let fixtures = try fixtureURLs()
            var reader = FrameReader()
            for name in ["negotiated.json", "status-response.json"] {
                guard let url = fixtures.first(where: { $0.lastPathComponent == name }) else {
                    return ["\(name) is missing from test resources"]
                }
                let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
                reader.append(try JSONSerialization.data(withJSONObject: object))
                reader.append(Data([0x0A]))
            }
            guard case .negotiated(let negotiated)? = try reader.nextFrame() else {
                return ["daemon capabilities did not decode as negotiation before status"]
            }
            if negotiated.capabilities.map(\.rawValue) != expectedCapabilities {
                failures.append("negotiated capabilities differ from daemon CONTROL_CAPABILITIES")
            }
            guard negotiated.capabilities.contains(.statusGet) else {
                return failures + ["negotiation does not allow status.get"]
            }
            let request = ControlFrame.request(.statusGet(id: "status-1"))
            if try ControlCodec.decode(ControlCodec.encode(request)) != request {
                failures.append("status.get request did not round trip after negotiation")
            }
            guard case .response(.status(let id, let status))? = try reader.nextFrame() else {
                return failures + ["status response was blocked after daemon capability negotiation"]
            }
            if id != "status-1" || status.bootstrap.state != .running {
                failures.append("status response after negotiation lost its request ID or running state")
            }
            if try reader.nextFrame() != nil || reader.pendingByteCount != 0 {
                failures.append("negotiation/status stream left unexpected buffered frames")
            }
        } catch {
            failures.append("daemon negotiation/status stream threw: \(error)")
        }
        do {
            let unknown = Data("{\"type\":\"negotiated\",\"v\":1,\"capabilities\":[\"peers.unknown\"]}".utf8)
            _ = try ControlCodec.decode(unknown)
            failures.append("negotiation silently accepted an unknown capability")
        } catch DecodingError.dataCorrupted {
            // Capability decoding remains closed to the daemon's supported protocol.
        } catch {
            failures.append("unknown capability threw an unexpected error: \(error)")
        }
        return failures
    }

    private static func statusFixtureFailures() -> [String] {
        var failures: [String] = []

        // Canonical: running, credentials passed, iMessage detached because FDA is denied.
        switch status(named: "status-response.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let payload):
            if payload.bootstrap.state != .running {
                failures.append("status fixture bootstrap state was not typed as running")
            }
            if payload.bootstrap.probes["credentials"]?.status != "passed" {
                failures.append("status fixture credentials probe was not typed")
            }
            if payload.bootstrap.probes["fda"]?.status != "denied" {
                failures.append("status fixture fda probe was not typed as denied")
            }
            if payload.bootstrap.probes["messages"]?.aliases != ["gajae@example.com"] {
                failures.append("status fixture message aliases were not typed")
            }
            if payload.imessage.state != .detached || payload.imessage.reason != "fda_denied" {
                failures.append("status fixture iMessage lane was not typed as detached/fda_denied")
            }
            if payload.imessage.handle != "+821012345678" {
                failures.append("status fixture iMessage handle was not typed")
            }
            if payload.session.mainSessionId != "main-session-001" {
                failures.append("status fixture main session id was not typed")
            }
            if payload.activeChildren.map(\.kind) != [.taskTool] || payload.recentChildren.map(\.kind) != [.daemon, .taskTool] {
                failures.append("status fixture child kinds were not typed")
            }
            if payload.activeChildren.map(\.state) != [.idle] || payload.recentChildren.map(\.state) != [.cold, .terminated] {
                failures.append("status fixture conversational child states were not typed")
            }
            if payload.activeChildren.first?.lastActivityAt != "2026-01-01T00:00:05.000Z" {
                failures.append("status fixture child last activity was not typed")
            }
            if payload.monitors.first?.nextFire != "2026-01-05T08:30:00.000Z" {
                failures.append("status fixture monitor next fire was not typed")
            }
            if payload.settings.allowlistHandle != "+821012345678" {
                failures.append("status fixture allowlist handle was not typed")
            }
            // Attention items are gated on an attached lane, so a detached
            // install must not raise the accessibility or image_paste item.
            if payload.attention != nil {
                failures.append("detached status fixture should not carry an attention item")
            }
        }

        // Credentials missing: the core lane is down, so the lane reason follows it.
        switch status(named: "status-response-credentials-blocked.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let payload):
            if payload.bootstrap.state != .credentialsBlocked {
                failures.append("credentials-blocked fixture state was not typed")
            }
            if payload.bootstrap.probes["credentials"]?.status != "missing" {
                failures.append("credentials-blocked fixture credentials probe was not typed as missing")
            }
            if payload.imessage.state != .detached || payload.imessage.reason != "core_lane_down" {
                failures.append("credentials-blocked fixture lane was not typed as detached/core_lane_down")
            }
        }

        // Handle configured and FDA granted: the lane is attached.
        switch status(named: "status-response-attached.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let payload):
            if payload.bootstrap.state != .running {
                failures.append("attached fixture state was not typed as running")
            }
            if payload.imessage.state != .attached {
                failures.append("attached fixture lane was not typed as attached")
            }
            if payload.imessage.handle != "+821012345678" {
                failures.append("attached fixture handle was not typed")
            }
            if payload.imessage.reason != nil {
                failures.append("attached fixture should not carry a detach reason")
            }
        }

        // Chat-only install: no handle, so the TCC probes were never run.
        switch status(named: "status-response-no-handle.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let payload):
            if payload.bootstrap.state != .running {
                failures.append("no-handle fixture state was not typed as running")
            }
            if payload.bootstrap.probes["fda"] != nil || payload.bootstrap.probes["accessibility"] != nil {
                failures.append("no-handle fixture must not carry fda/accessibility probes")
            }
            if payload.imessage.state != .detached || payload.imessage.reason != "no_owner_handle" {
                failures.append("no-handle fixture lane was not typed as detached/no_owner_handle")
            }
            if payload.imessage.handle != nil {
                failures.append("no-handle fixture must not carry an iMessage handle")
            }
            if payload.settings.allowlistHandle != nil {
                failures.append("no-handle fixture must not report an allowlist handle")
            }
        }

        return failures
    }

    private static func chatFixtureFailures() -> [String] {
        var failures: [String] = []

        switch frame(named: "chat-history-response.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let frame):
            guard case .response(.chatHistory(_, let history)) = frame else {
                failures.append("chat-history-response.json did not decode as a typed chat history response")
                return failures
            }
            if history.messages.count != 4 {
                failures.append("chat history fixture message count was not typed")
            }
            if history.messages.first?.source != "imessage" {
                failures.append("chat history fixture first row source was not typed as imessage")
            }
            if !history.messages.contains(where: { $0.source == "panel" }) {
                failures.append("chat history fixture is missing a panel-sourced owner row")
            }
            if !history.messages.contains(where: { $0.image != nil }) {
                failures.append("chat history fixture is missing an image row")
            }
            if history.seq != 42 {
                failures.append("chat history fixture seq was not typed")
            }
            if history.tail.count != 2 {
                failures.append("chat history fixture tail count was not typed")
            }
            if history.inFlight?.turnId != "panel-turn-002" || history.inFlight?.typing != true {
                failures.append("chat history fixture inFlight was not typed")
            }
            if history.tailTruncated != true {
                failures.append("chat history fixture tailTruncated was not typed")
            }
        }

        switch event(named: "chat-message-image-event.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let event):
            guard case .chatMessage(let payload) = event else {
                failures.append("chat-message-image-event.json did not decode as a chat message event")
                return failures
            }
            if payload.image == nil {
                failures.append("image event payload did not carry an image reference")
            }
        }

        switch event(named: "chat-message-assistant-final-event.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let event):
            guard case .chatMessage(let payload) = event else {
                failures.append("chat-message-assistant-final-event.json did not decode as a chat message event")
                return failures
            }
            if payload.final != true {
                failures.append("final assistant event did not carry final == true")
            }
        }

        switch event(named: "chat-presence-event.json") {
        case .bad(let message):
            failures.append(message)
        case .ok(let event):
            guard case .chatPresence(let payload) = event else {
                failures.append("chat-presence-event.json did not decode as a chat presence event")
                return failures
            }
            if payload.seq <= 0 {
                failures.append("presence event did not carry a positive seq")
            }
        }

        return failures
    }

    /// `ControlResponse` decodes by ordered structural trial. A chat payload
    /// inserted after a structurally broader payload would be swallowed by it,
    /// so every response fixture must resolve to exactly one case.
    private static func crossDecodeFailures() -> [String] {
        var failures: [String] = []
        let expected: [String: String] = [
            "status-response.json": "status",
            "status-response-credentials-blocked.json": "status",
            "status-response-attached.json": "status",
            "status-response-no-handle.json": "status",
            "chat-send-response.json": "chatSend",
            "chat-history-response.json": "chatHistory",
            "chat-subscribe-response.json": "chatSubscribe",
        ]
        for (name, wanted) in expected.sorted(by: { $0.key < $1.key }) {
            switch frame(named: name) {
            case .bad(let message):
                failures.append(message)
            case .ok(let frame):
                guard case .response(let response) = frame else {
                    failures.append("\(name) did not decode as a response frame")
                    continue
                }
                let actual = caseName(of: response)
                if actual != wanted {
                    failures.append("\(name) resolved to \(actual) instead of \(wanted)")
                }
            }
        }

        do {
            guard let fixture = try fixtureURLs().first(where: { $0.lastPathComponent == "settings-get-response.json" }) else {
                failures.append("settings-get-response.json is missing from test resources")
                return failures
            }
            let frame = try ControlCodec.decode(Data(contentsOf: fixture))
            guard case .response(.settingsGet(_, let settings)) = frame else {
                failures.append("settings fixture did not decode as a typed settings response")
                return failures
            }
            if settings.childWarmTtlSec != 600 || settings.childIdleTimeoutSec != 86_400 || settings.childMaxLive != 16 {
                failures.append("settings fixture child lifetime limits were not typed")
            }
            if settings.childInterimBatchSec != 3 || settings.childInterimRatePerMinute != 6 || settings.childInterimMaxBytes != 1_024 {
                failures.append("settings fixture interim limits were not typed")
            }
            if settings.childStatusListLimit != 20 || settings.childStatusTextBytes != 512 || settings.childToolGuardMs != 50 {
                failures.append("settings fixture child tool limits were not typed")
            }
        } catch {
            failures.append("typed settings fixture decoding threw: \(error.localizedDescription)")
        }

        do {
            let source = Data("{\"status\":\"passed\",\"aliases\":[\"gajae@example.com\",\"+821012345678\"]}".utf8)
            let probe = try JSONDecoder().decode(ProbeInfo.self, from: source)
            if probe.aliases != ["gajae@example.com", "+821012345678"] {
                failures.append("ProbeInfo aliases did not decode")
            }
            let encoded = try JSONEncoder().encode(probe)
            let sourceObject = try JSONSerialization.jsonObject(with: source)
            let encodedObject = try JSONSerialization.jsonObject(with: encoded)
            if !(sourceObject as AnyObject).isEqual(encodedObject) {
                failures.append("ProbeInfo aliases did not round trip")
            }
        } catch {
            failures.append("ProbeInfo aliases round trip threw: \(error.localizedDescription)")
        }

        do {
            let request = ControlFrame.request(.accountsDiscover(id: "discover-request"))
            let encoded = try ControlCodec.encode(request)
            let decoded = try ControlCodec.decode(encoded)
            if decoded != request {
                failures.append("accounts.discover request did not round trip")
            }
        } catch {
            failures.append("accounts.discover request round trip threw: \(error.localizedDescription)")
        }

        do {
            let adoptable = DiscoveredCredential(
                id: "anthropic:claude-code-keychain",
                provider: "anthropic",
                label: "Claude (Anthropic)",
                source: "Claude Code (macOS Keychain)",
                kind: "oauth",
                redactedToken: "sk-ant…1234",
                identity: "owner@example.com",
                expiresAt: "2026-01-05T08:30:00.000Z",
                adoptable: true
            )
            let expired = DiscoveredCredential(
                id: "openai-codex:codex-file",
                provider: "openai-codex",
                label: "ChatGPT / Codex (OpenAI)",
                source: "Codex (~/.codex/auth.json)",
                kind: "oauth",
                redactedToken: "sk-oai…5678",
                adoptable: false,
                reason: "This login has expired. Sign in to Claude Code again, or sign in here separately."
            )
            let response = ControlFrame.response(.accountsDiscover(
                id: "discover-response",
                payload: AccountsDiscoverResponsePayload(credentials: [adoptable, expired])
            ))
            let encoded = try ControlCodec.encode(response)
            let decoded = try ControlCodec.decode(encoded)
            if decoded != response {
                failures.append("accounts.discover response did not round trip")
            }
            if let root = try JSONSerialization.jsonObject(with: encoded) as? [String: Any],
               let payload = root["payload"] as? [String: Any],
               let credentials = payload["credentials"] as? [[String: Any]],
               credentials.count == 2 {
                if credentials[0].keys.contains("reason") {
                    failures.append("nil discovered credential reason was encoded")
                }
                if credentials[1].keys.contains("identity") || credentials[1].keys.contains("expiresAt") {
                    failures.append("nil discovered credential optionals were encoded")
                }
                if credentials[1]["reason"] as? String != expired.reason {
                    failures.append("discovered credential reason did not encode")
                }
            } else {
                failures.append("accounts.discover response payload was not inspectable")
            }
        } catch {
            failures.append("accounts.discover response round trip threw: \(error.localizedDescription)")
        }

        do {
            let request = ControlFrame.request(.accountsAdopt(
                id: "adopt-request",
                payload: AccountsAdoptPayload(id: "anthropic:claude-code-keychain")
            ))
            let encodedRequest = try ControlCodec.encode(request)
            let decodedRequest = try ControlCodec.decode(encodedRequest)
            if decodedRequest != request {
                failures.append("accounts.adopt request did not round trip")
            }

            let response = ControlFrame.response(.accountsAdopt(
                id: "adopt-response",
                payload: AccountsAdoptResponsePayload(adopted: true, provider: "anthropic", restarting: true)
            ))
            let encodedResponse = try ControlCodec.encode(response)
            let decodedResponse = try ControlCodec.decode(encodedResponse)
            if decodedResponse != response {
                failures.append("accounts.adopt response did not round trip")
            }
        } catch {
            failures.append("accounts.adopt round trip threw: \(error.localizedDescription)")
        }
        return failures
    }

    private static func caseName(of response: ControlResponse) -> String {
        switch response {
        case .status: return "status"
        case .chatSend: return "chatSend"
        case .chatHistory: return "chatHistory"
        case .chatSubscribe: return "chatSubscribe"
        default: return "other"
        }
    }

    private static func status(named name: String) -> Decoded<StatusResponsePayload> {
        switch frame(named: name) {
        case .bad(let message):
            return .bad(message)
        case .ok(let frame):
            guard case .response(.status(_, let status)) = frame else {
                return .bad("\(name) did not decode as a typed status response")
            }
            return .ok(status)
        }
    }

    private static func event(named name: String) -> Decoded<ControlEvent> {
        switch frame(named: name) {
        case .bad(let message):
            return .bad(message)
        case .ok(let frame):
            guard case .event(let event) = frame else {
                return .bad("\(name) did not decode as an event frame")
            }
            return .ok(event)
        }
    }

    private static func frame(named name: String) -> Decoded<ControlFrame> {
        do {
            guard let fixture = try fixtureURLs().first(where: { $0.lastPathComponent == name }) else {
                return .bad("\(name) is missing from test resources")
            }
            return .ok(try ControlCodec.decode(Data(contentsOf: fixture)))
        } catch {
            return .bad("decoding \(name) threw: \(error.localizedDescription)")
        }
    }

    private static func fixtureURLs() throws -> [URL] {
        guard let resourceURL = Bundle.module.resourceURL else {
            throw ControlCodecError.invalidFrame("test fixture resources are unavailable")
        }
        let enumerator = FileManager.default.enumerator(
            at: resourceURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )
        return (enumerator?.allObjects as? [URL] ?? [])
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
