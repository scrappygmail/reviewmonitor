import "./globals.css";

export const metadata = {
  title: "Review Monitor",
  description: "Google Maps negative review monitor",
  manifest: "/manifest.json",
};

export const viewport = {
  themeColor: "#4F46E5",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="bg-paper text-ink font-body antialiased">{children}</body>
    </html>
  );
}
