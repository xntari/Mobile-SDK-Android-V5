/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'dji-blue': '#1E88E5',
        'dji-dark': '#0D1117',
        'dji-gray': '#21262D',
        'status-good': '#00D084',
        'status-warning': '#F59E0B',
        'status-error': '#EF4444'
      },
      fontFamily: {
        'mono': ['SF Mono', 'Monaco', 'monospace'],
      }
    },
  },
  plugins: [],
}