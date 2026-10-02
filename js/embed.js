// The loader a business adds to its page (ADR-AB-0001). It finds each <div data-booking-widget>,
// puts the widget in an iframe, and sizes the frame to the widget's content. The page can't read
// inside the frame, so it can never see what a customer types; the only thing it receives is a
// height, and only from that frame.
//
//   <div data-booking-widget data-brand="#0b5c8e"></div>
//   <script src="js/embed.js"></script>
(function () {
  var script = document.currentScript;
  if (!script) return;
  var widgetUrl = new URL('../widget/index.html', script.src);

  Array.prototype.forEach.call(document.querySelectorAll('[data-booking-widget]'), function (slot) {
    var url = new URL(widgetUrl.href);
    var brand = slot.getAttribute('data-brand');
    if (brand) url.searchParams.set('brand', brand);

    var frame = document.createElement('iframe');
    frame.src = url.href;
    frame.title = 'Online booking for Example Clinic (fictional)';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'display:block;width:100%;height:560px;border:0';
    slot.appendChild(frame);

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow) return;
      var data = event.data;
      if (!data || data.source !== 'appointment-booking-widget' || data.type !== 'resize' || typeof data.height !== 'number') return;
      frame.style.height = Math.min(Math.max(Math.ceil(data.height), 200), 4000) + 'px';
    });
  });
})();
