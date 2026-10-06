import Providers from './providers';
import './globals.css';

export const metadata = { title: 'E-waste Pickup PoC' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
