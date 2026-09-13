// The page loaded by the OBS browser source. It is fully transparent until a
// clip is triggered, plays that clip once, then clears itself and goes
// transparent again.
export const OVERLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OBS video overlay</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
  }
  #player {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    object-fit: contain;
    background: transparent;
    /* Hidden until a clip is triggered, and hidden again the moment it ends. */
    opacity: 0;
    visibility: hidden;
  }
  #player.visible {
    opacity: 1;
    visibility: visible;
  }
  #status {
    position: fixed;
    left: 8px;
    bottom: 8px;
    font: 12px/1.4 system-ui, sans-serif;
    color: #fff;
    background: rgba(0, 0, 0, .6);
    padding: 4px 8px;
    border-radius: 4px;
    display: none;
  }
  body.debug #status { display: block; }
</style>
</head>
<body>
  <video id="player" playsinline preload="auto"></video>
  <div id="status">waiting</div>
<script>
(function () {
  var player = document.getElementById('player');
  var statusBox = document.getElementById('status');
  var playing = false;
  var currentFile = null;
  // Bumped on every play/hide so a late play() rejection from a clip that has
  // already been replaced can be told apart from one for the current clip.
  var generation = 0;
  var PAGE_VERSION = '__OVERLAY_VERSION__';
  // Audio output devices as last enumerated, and the sink id currently
  // applied to the player ('' is the browser default).
  var outputs = [];
  var appliedSink = '';

  // Add ?debug=1 to the browser source URL to see connection state on screen.
  if (new URLSearchParams(location.search).has('debug')) document.body.classList.add('debug');

  function status(text) { statusBox.textContent = text; }

  function hide() {
    player.classList.remove('visible');
    player.pause();
    player.removeAttribute('src');
    player.load();
    playing = false;
    currentFile = null;
    generation++;
    status('waiting');
  }

  function play(event) {
    playing = true;
    currentFile = event.file;
    var mine = ++generation;
    player.style.objectFit = event.fit || 'contain';
    player.volume = typeof event.volume === 'number' ? event.volume : 1;
    player.muted = false;
    player.src = event.src;
    status('playing ' + event.name);
    applySink(event.sink || '');

    var started = player.play();
    if (started && started.catch) {
      started.catch(function (err) {
        // A newer clip (or a stop) has taken over: this rejection is stale.
        // Replacing the source aborts the pending play() with AbortError.
        if (mine !== generation || err.name === 'AbortError') return;
        // OBS allows autoplay with sound; a normal browser may not. Retry muted
        // so the clip is still shown rather than silently skipped.
        status('autoplay blocked (' + err.name + '), retrying muted');
        player.muted = true;
        player.play().catch(function () { hide(); });
      });
    }
    player.classList.add('visible');
  }

  player.addEventListener('ended', function () { hide(); });

  player.addEventListener('error', function () {
    // load() after clearing the source also fires error; ignore that case.
    if (!player.getAttribute('src')) return;
    status('error loading clip');
    hide();
  });

  // Only the page can see audio output devices, and their ids mean nothing
  // outside this browser, so the page reports the list to the daemon for
  // --list-audio-devices and keeps a copy for routing. Chromium hides the
  // labels until the page has had media permission once; ask for it only
  // when that is the case. Inside OBS no prompt is shown either way.
  var media = navigator.mediaDevices;

  function listOutputs() {
    return media.enumerateDevices().then(function (devices) {
      return devices.filter(function (d) { return d.kind === 'audiooutput'; });
    });
  }

  function reportDevices() {
    if (!media || !media.enumerateDevices) return;
    listOutputs()
      .then(function (devices) {
        var unlabeled = devices.length > 0 && devices.every(function (d) { return !d.label; });
        if (!unlabeled || !media.getUserMedia) return devices;
        return media.getUserMedia({ audio: true }).then(function (stream) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          return listOutputs();
        }, function () { return devices; });
      })
      .then(function (devices) {
        outputs = devices.map(function (d) { return { id: d.deviceId, label: d.label || '' }; });
        return fetch('/audio-devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ devices: outputs }),
        });
      })
      .catch(function () {});
  }

  if (media && media.addEventListener) media.addEventListener('devicechange', reportDevices);
  reportDevices();

  // Routes the player's audio to the device the daemon asked for. The name is
  // matched against the label (case-insensitive substring) or the exact id.
  // No match, or a browser without setSinkId: play on the default device.
  function applySink(name) {
    if (!player.setSinkId) return;
    var wanted = '';
    if (name) {
      var lower = name.toLowerCase();
      for (var i = 0; i < outputs.length; i++) {
        if (outputs[i].id === name || outputs[i].label.toLowerCase().indexOf(lower) !== -1) {
          wanted = outputs[i].id;
          break;
        }
      }
      if (!wanted) status('audio device not found: ' + name + ', using default');
    }
    if (wanted === appliedSink) return;
    appliedSink = wanted;
    var result = player.setSinkId(wanted);
    if (result && result.catch) {
      result.catch(function (err) {
        status('audio device rejected (' + err.name + '), using default');
        appliedSink = '';
        player.setSinkId('').catch(function () {});
      });
    }
  }

  var source = new EventSource('/events');
  source.onopen = function () { status('connected'); };
  source.onerror = function () { status('disconnected, reconnecting'); };
  source.onmessage = function (message) {
    var event;
    try { event = JSON.parse(message.data); } catch (err) { return; }

    // The daemon was rebuilt while this page stayed open in OBS: reload so the
    // page and the daemon agree on how triggers behave.
    if (event.type === 'hello') {
      if (event.version !== PAGE_VERSION) location.reload();
      return;
    }

    if (event.type === 'stop') { hide(); return; }
    if (event.type !== 'play') return;

    // Same file triggered again while it is still on screen: treat the trigger as
    // a toggle and take it away. Once it has finished on its own, the next
    // trigger plays it again from the start.
    if (playing && currentFile === event.file) {
      status('toggled off ' + event.name);
      hide();
      return;
    }

    // Any other trigger replaces whatever is on screen right now - the newest
    // clip always wins, nothing is queued.
    hide();
    play(event);
  };
})();
</script>
</body>
</html>
`;
