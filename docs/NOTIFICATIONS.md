# Notifications

Terminal and desktop notifications fire when the agent finishes a turn and is waiting for you. They adapt dynamically: if a flow completed, the title shows the flow name and acceptance summary; if `ask_user` is pending, the title changes to "Decision Required".

## Configuration

Configure notifications with global `~/.pi/agent/extensions/notify.json` or project `.pi/notify.json`. Project settings override global.

```json
{
  "enabled": true,
  "onlyWhenInteractive": true,
  "title": "π",
  "body": "task accomplished!",
  "channels": {
    "terminal": true,
    "desktop": true,
    "bell": true,
    "sound": false
  },
  "terminal": { "backend": "auto" },
  "desktop": { "backend": "auto" },
  "sound": {
    "backend": "auto",
    "name": "Glass",
    "linuxSoundId": "complete",
    "frequencyHz": 1000,
    "durationMs": 250,
    "command": ""
  }
}
```

| Key | Description |
|-----|-------------|
| `enabled` | Master switch for notifications |
| `onlyWhenInteractive` | Only notify when a UI is attached |
| `channels.terminal` | OSC 777/99 terminal notifications |
| `channels.desktop` | OS native notifications (macOS, Linux, Windows) |
| `channels.bell` | Terminal bell |
| `channels.sound` | System beep or custom sound |

## Backends

| Channel | Backends |
|---------|----------|
| Terminal | `auto` (detect OSC support), `osc777`, `osc99`, `none` |
| Desktop | `auto` (detect OS), `macos`, `linux`, `windows-toast`, `none` |
| Sound | `auto`, `macos`, `linux`, `windows-beep`, `command`, `none` |

When the terminal channel is active and the emulator supports visual OSC notifications (e.g. Warp, iTerm2, kitty), the auto-detected desktop channel is skipped to avoid duplicates.
