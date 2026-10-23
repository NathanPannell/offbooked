import AVFoundation
import Capacitor
import MediaPlayer
import UIKit

/// What the web app asks of iOS itself (src/native/offbooked.ts):
/// - the run-through keeps playing with the screen locked or the app in the background (the
///   `audio` background mode in Info.plist plus a playback audio session), and shows on the lock
///   screen and in Control Center with play, pause, next and previous (Now Playing);
/// - a take still uploading when the app goes to the background gets the time iOS allows to finish.
@objc(OffbookedNativePlugin)
public class OffbookedNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OffbookedNativePlugin"
    public let jsName = "OffbookedNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginBackgroundWork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endBackgroundWork", returnType: CAPPluginReturnPromise)
    ]

    private var commandTargets: [(MPRemoteCommand, Any)] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    // MARK: Now Playing

    /// { title, artist, album, playing }. Called as the run-through starts, pauses and moves line.
    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "Offbooked"
        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? ""
        let playing = call.getBool("playing") ?? false
        DispatchQueue.main.async {
            if playing { self.activatePlayback() }
            self.registerCommands()
            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: artist,
                MPMediaItemPropertyAlbumTitle: album,
                MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
                MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
            ]
            if let icon = UIImage(named: "AppIcon") ?? UIImage(named: "Splash") {
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: icon.size) { _ in icon }
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            call.resolve()
        }
    }

    /// The run-through screen closed: nothing is playing any more.
    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            self.unregisterCommands()
            call.resolve()
        }
    }

    /// Playback, so the run-through plays through the silent switch and with the screen locked.
    /// Recording needs no session here: WebKit switches it to play-and-record while the mic is open.
    private func activatePlayback() {
        let session = AVAudioSession.sharedInstance()
        do {
            if session.category != .playback {
                try session.setCategory(.playback, mode: .spokenAudio, options: [.allowAirPlay, .allowBluetoothA2DP])
            }
            try session.setActive(true)
        } catch {
            CAPLog.print("OffbookedNative: audio session failed: \(error)")
        }
    }

    private func registerCommands() {
        guard commandTargets.isEmpty else { return }
        let center = MPRemoteCommandCenter.shared()
        let commands: [(MPRemoteCommand, String)] = [
            (center.playCommand, "play"),
            (center.pauseCommand, "pause"),
            (center.togglePlayPauseCommand, "toggle"),
            (center.nextTrackCommand, "next"),
            (center.previousTrackCommand, "previous")
        ]
        for (command, name) in commands {
            command.isEnabled = true
            let target = command.addTarget { [weak self] _ in
                self?.notifyListeners("remoteCommand", data: ["command": name])
                return .success
            }
            commandTargets.append((command, target))
        }
    }

    private func unregisterCommands() {
        for (command, target) in commandTargets {
            command.removeTarget(target)
            command.isEnabled = false
        }
        commandTargets.removeAll()
    }

    // MARK: Background work

    /// Asks iOS for time to finish what's running (a take uploading) if the app goes to the
    /// background now. Idempotent: one task at a time, ended by endBackgroundWork or by iOS.
    @objc func beginBackgroundWork(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.backgroundTask == .invalid {
                self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "offbooked.uploads") { [weak self] in
                    self?.endTask()
                }
            }
            call.resolve()
        }
    }

    @objc func endBackgroundWork(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endTask()
            call.resolve()
        }
    }

    private func endTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
