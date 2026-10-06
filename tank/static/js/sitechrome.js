/*
 * sitechrome.js — the showcase website's header and footer on the public phone
 * pages (draw, upload), so a visitor never feels they left the site.
 *
 * Put <header id="site-head"></header> and <footer id="site-foot"></footer> in
 * the page, set window.SITE_URL (the server injects it, see SITE_URL in
 * serve.py) and load this file. A tank at home (TANK_MODE=home) has no website:
 * nothing is drawn.
 */
(function () {
  if (window.TANK_MODE === "home") return;
  var S = window.SITE_URL || "../";
  var GH = "https://github.com/Rogzy-DB/fish-party";

  var head = document.getElementById("site-head");
  if (head) {
    head.className = "site-head";
    head.innerHTML =
      '<a class="brand" href="' + S + '">🐠 Fish Party</a>' +
      '<nav class="site-tabs" aria-label="Fish Party">' +
      '<a href="' + S + '">Home</a>' +
      '<a href="' + S + 'how/">How it works</a>' +
      '<a href="' + S + 'host/">Host</a>' +
      '<a href="' + S + 'collective/" aria-current="page">Collective tank</a>' +
      '<a href="' + S + 'about/">About</a>' +
      "</nav>";
  }

  var foot = document.getElementById("site-foot");
  if (foot) {
    foot.className = "site-foot";
    foot.innerHTML =
      '<div class="fish-line">🐟 🐠 🦈 🐙 🐡</div>' +
      '<nav class="foot-links">' +
      '<a href="' + S + 'how/">How it works</a> · <a href="' + S + 'host/">Host your own</a> · ' +
      '<a href="' + S + 'collective/">Collective tank</a> · <a href="' + S + 'about/">About</a> · ' +
      '<a href="' + GH + '">GitHub</a></nav>' +
      '<p>Inspired by <a href="https://futurepark.teamlab.art/en/playinstallations/sketch_aquarium/">teamLab\'s Sketch Aquarium</a>: go see the real one if you ever can.<br>' +
      "Code under the MIT licence · party drawings under CC BY-NC 4.0 · bubbles from " +
      '<a href="https://mempool.space">mempool.space</a>.<br>Made by Rogzy &amp; Luna</p>';
  }
})();
