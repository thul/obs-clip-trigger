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
  var PAGE_VERSION = '__OVERLAY_VERSION__';

  // Add ?debug=1 to the browser source URL to see connection state on screen.
  if (location.search.indexOf('debug') !== -1) document.body.classList.add('debug');

  function status(text) { statusBox.textContent = text; }

  function hide() {
    player.classList.remove('visible');
    player.pause();
    player.removeAttribute('src');
    player.load();
    playing = false;
    currentFile = null;
    status('waiting');
  }

  function play(event) {
    playing = true;
    currentFile = event.file;
    player.style.objectFit = event.fit || 'contain';
    player.volume = typeof event.volume === 'number' ? event.volume : 1;
    player.muted = false;
    player.src = event.src;
    status('playing ' + event.name);

    var started = player.play();
    if (started && started.catch) {
      started.catch(function (err) {
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
