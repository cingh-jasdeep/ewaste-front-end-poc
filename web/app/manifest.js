// Web app manifest (makes the app installable; required for push on iOS).
export default function manifest() {
  return {
    name: 'E-waste Pickup',
    short_name: 'E-waste',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1D9E75',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
