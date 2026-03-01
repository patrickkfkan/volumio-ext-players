# volumio-ext-players

Start, control and monitor [vlc](https://www.videolan.org/) or [mpv](https://mpv.io/) in Volumio.

### Background

This project, originally developed for the Volumio [SoundCloud plugin](https://github.com/patrickkfkan/volumio-soundcloud), now aims to provide a versatile toolset for any plugins that may find it beneficial.

<details>
  <summary><code>How this project started</code></summary>

  Created for Volumio [SoundCloud plugin](https://github.com/patrickkfkan/volumio-soundcloud) to provide support for HLS+AAC and HLS+Opus streams. Originally, I hoped I could use [MusicPlayerDaemon](https://www.musicpd.org/) (MPD) to handle these streams, because it's already available and decently integrated with Volumio. But:
  - HLS+AAC plays, but seeking results in silence and renders MPD unresponsive.
  - HLS+Opus won't play at all. This is due to FFmpeg rejecting non-standard HLS stream segments. This is solvable by passing `extension_picky=0`, `allowed_extensions=ALL` and `allowed_segment_extensions=ALL` to FFmpeg, but there is no option in MPD configuration to do this.

  After a bit of testing, I found that:
  - VLC handles HLS+AAC streams fine with seeking possible; but it fails with HLS+Opus streams (same FFmpeg issue).
  - mpv can handle HLS+Opus streams after passing the relevant FFmpeg options.

  To use these players in Volumio, the SoundCloud plugin needs to set itself as a "volatile" plugin. This means it is responsible for pretty much everything that happens before, during and after playback, including:
  - running, controlling and monitoring the player;
  - providing state updates to Volumio;
  - handling commands from Volumio, like "next", "previous", "pause", "repeat" and "random";
  - if appropriate, moving on to the next track when current playback ends.

  I could do all this within the plugin, or come up with a separate reusable module. The latter makes more sense, hence this project.

</details>

### Usage

Install `vlc` and `mpv` in `install.sh` of your plugin:

```
...

echo "Installing VLC media player..."
sudo apt update
sudo apt-get install -y vlc-bin vlc-plugin-base

echo "Installing mpv media player..."
sudo apt-get install -y mpv

...
```

Starting the player:

```
const { MPVService, VLCService } = require('volumio-ext-players');

// Common vars
const serviceName = 'mymusicservice';
const logger = {
  info: (msg) => { ... }
  warn: (msg) => { ... }
  error: (msg) => { ... } 
};
const volumioCtx = {
  commandRouter: sc.volumioCoreCommand,
  mpdPlugin: sc.getMpdPlugin(),
  statemachine: sc.getStateMachine()

  // Optional - modify state before sending it to Volumio
  stateTransformer: {
    transformStateBeforePush(state) {
      // Modify state
      const transformed = {
        ...state,
        title: 'Custom title'
      };
      // Return it
      return transformed;
    },

    modifyVolatileSeekBeforeSet(playerTime) {
      return playerTime - 10;
    }
  }

  // When player stops, should the service automatically disengage (unset volatile)?
  // Values:
  // - `always` (default)
  // - `never`
  // - `manual`: disengage when player stops as a result of stop() being called.
  unsetVolatileOnStop: 'manual'
};

// Start VLC
const vlc = new VLCService({
  serviceName,
  logger,
  volumio: volumioCtx
});

await vlc.start();

// Start mpv

const mpv = new MPVService({
  serviceName,
  logger,
  volumio: volumioCtx,
  mpvArgs: [
    // args passed to mpv
    '--demuxer=lavf',
    '--demuxer-lavf-o=extension_picky=0,allowed_extensions=ALL,allowed_segment_extensions=ALL'
  ]
});

await mpv.start();
```

Controlling the player:
```
// Play a track
// uri and streamUrl are required; rest is optional, but provide
// as much as you can, otherwise they will be obtained from the player
// status (not guaranteed to be available).
await vlc.play({
  uri: ...  // URI recognized by Volumio (the one sent to explodeUri()) 
  streamUrl: ... // The URL of the actual stream to be played
  title: ...
  artist: ...
  album: ...
  albumart: ...
  trackType: ...
  duration: ...
  samplerate: ...
  bitdepth: ...
  bitrate: ...
  channels: ...
});

// Pause and resume
await vlc.pause();
await vlc.resume();

// Seek to 30 seconds
await vlc.seek(30);

// Stop the player
// This sets the player to idle state, and releases
// the audio device.
// Not to be confused with quit(), which actually
// ends the player's system process.
await vlc.stop();

// Move to previous / next track
await vlc.previous();
await vlc.next();

// Set random - note this is not async
vlc.setRandom(true);

// Set repeat / repeat single
await vlc.setRepeat(true, true);

// Quit the player
// This will end the player's system process
vlc.quit();
```

Monitoring is automatic and state updates are sent to Volumio as necessary, but sometimes you might want to inspect the player status:

```
// Get the current player status
const status = vlc.getStatus();

// Is the player active and not idle?
if (vlc.isActive()) {
  ...
}

// Listen for status changes
vlc.on('status', (status) => {
  ...
});

// Get notified when player's system process is closed.
// This could be due to quitting the player intentionally or
// the player has simply crashed.
vlc.on('close', (code, signal) => {
  ...
});
```

You can also manually send a state update to Volumio:

```
vlc.pushState();
```

Note the use of `await` in the above examples. Since Volumio still uses [kew](https://github.com/Medium/kew), make sure you wrap your async calls into kew-compatible Promises.

### Changelog

v1.1.0
- `play()`: add `start` option to indicate position from which to start playback.
- Add `pushState()` to allow manual dispatch of Volumio state.
- Add `unsetVolatileOnStop` option to specify condition on which to unset volatile state.
- Add `stateTransformer` option for modifying state before sending it to Volumio.
- Add spawn options
- mpv: resolve `loadfile` command differences across different versions.

v1.0.0
- Initial release

### License

MIT
