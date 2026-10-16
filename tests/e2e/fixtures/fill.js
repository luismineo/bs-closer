// Shared fixture helpers: a long article (so the page scrolls) and a delayed popup.
for (let i = 0; i < 40; i++) {
  const p = document.createElement('p');
  p.textContent = `Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`;
  document.body.append(p);
}

/** Append `html` to <body> after `ms`; elements with [data-close] remove the popup when clicked. */
function popupLater(html, ms = 3500, onShow) {
  setTimeout(() => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    const el = t.content.firstElementChild;
    for (const b of el.querySelectorAll('[data-close]')) b.addEventListener('click', () => el.remove());
    document.body.append(el);
    if (onShow) onShow(el);
  }, ms);
}
