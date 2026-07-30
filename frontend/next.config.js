/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",   // static export - runs on Cloudflare Pages with zero adapter/bundler needed
};

module.exports = nextConfig;
