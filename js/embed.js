// The loader a business adds to its page (ADR-AB-0001). It finds each <div data-booking-widget>,
// puts the widget in an iframe, and sizes the frame to the widget's content. The page can't read
// inside the frame, so it can never see what a customer types; the only thing it receives is a
// height, and only from that frame.
//
//   <div data-booking-widget data-brand="#0b5c8e"></div>
//   <script src="js/embed.js"></script>
//
// With the real API running, open this page as  /?api=http://127.0.0.1:8813&key=pk_...  and the
// widget is loaded from the API's own origin, as it would be from a vendor's. That origin refuses to
// be framed by any page the business has not registered, and the loader tells the widget which page
// it is on in the one way the browser vouches for: the origin of a postMessage.
(function () {
  var script = document.currentScript;
  if (!script) return;

  var params = new URLSearchParams(location.search);
  var apiOrigin = params.get('api');
  var key = params.get('key');
  // Only a loopback address is accepted, so this page can't be turned into a way to load a stranger's widget.
  var useApi = !!(apiOrigin && key && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiOrigin));
  var widgetUrl = useApi ? new URL('/widget/index.html', apiOrigin) : new URL('../widget/index.html', script.src);
  var widgetOrigin = widgetUrl.origin;

  Array.prototype.forEach.call(document.querySelectorAll('[data-booking-widget]'), function (slot) {
    var url = new URL(widgetUrl.href);
    var brand = slot.getAttribute('data-brand');
    if (brand) url.searchParams.set('brand', brand);
    if (useApi) url.searchParams.set('key', key);

    var frame = document.createElement('iframe');
    frame.src = url.href;
    frame.title = 'Online booking for Example Clinic (fictional)';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'display:block;width:100%;height:560px;border:0';
    slot.appendChild(frame);

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow || event.origin !== widgetOrigin) return;
      var data = event.data;
      if (!data || data.source !== 'appointment-booking-widget') return;
      if (data.type === 'ready') {
        frame.contentWindow.postMessage({ source: 'appointment-booking-loader', type: 'init' }, widgetOrigin);
      } else if (data.type === 'resize' && typeof data.height === 'number') {
        frame.style.height = Math.min(Math.max(Math.ceil(data.height), 200), 6000) + 'px';
      }
    });
  });
})();
