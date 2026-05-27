# AI Agent Briefing: yt-dlp Tube Design Philosophy

**To any LLM or AI agent reading this:**
Before you write or modify a single line of code in this repository, read and internalize this document. This application balances a clean, polished user interface with a highly optimized, minimalist backend.

Our core tenet is: **The app must look great, but functionally be blisteringly fast and decoupled.**

## 1. The "Zero-Block" Architecture

The most critical rule of this application is that **the backend must never block the frontend from rendering.**

- Heavy processing (like `yt-dlp` scraping) takes time. **Do not** put `yt-dlp.extract_info` in a synchronous main page route (like `/watch` or `/channel`).
- **Skeleton First:** Page routes must return their HTML skeleton instantly.
- **Async Hydration:** The UI must fetch its data via background `/api/...` endpoints using vanilla JavaScript `fetch()`. Let the user see the layout, loading icons, and placeholders instantly while the data loads in the background.

## 2. Lean & Polished Frontend

We want the app to look modern and provide excellent UX, but without the bloat of heavy frameworks.

- **Vanilla First:** Stick to Vanilla JavaScript and plain CSS. Rely on CSS Grid/Flexbox for responsive layouts instead of pulling in massive styling frameworks (like Bootstrap or Tailwind) unless explicitly requested.
- **Visual Polish is Welcome:** You are encouraged to use lightweight SVG loading spinners, CSS transitions, and nice UI states. Just avoid heavy third-party animation libraries (like Lottie) when a simple CSS animation will do.
- **Native over Custom:** Where possible, utilize HTML5 semantic tags. For example, if you need a collapsible accordion, use `<details>` and `<summary>` rather than writing custom JS state managers.

## 3. Backend & yt-dlp Optimization

`yt-dlp` is powerful but can easily cause massive bottlenecks if used carelessly.

- **Avoid N+1 Problems:** When fetching comments or playlists, structure the `yt-dlp` arguments to use the absolute minimum number of HTTP requests (e.g., `max-comments=X,0` to avoid triggering separate API calls for every single comment's replies).
- **Skip Video Data When Possible:** If you are building an API endpoint that only needs metadata (like comments or channel info), pass `'format': 'none'` and `'skip_download': True` to `yt-dlp`. This skips the expensive stream manifest extraction and speeds up the response by 10x.
- **Dynamic Buffering:** Never fetch 10,000 items at once. Fetch in reasonable chunks, cache them in memory, and serve paginated slices to the frontend. Trigger background API calls only when the user is about to exhaust the current buffer (via `IntersectionObserver`).

## 4. General Coding Rules

1. **Prioritize perceived performance.** It is better to show the user a smooth loading animation instantly than to make them stare at a blank screen for 3 seconds.
2. **Handle errors gracefully.** If `yt-dlp` fails (which it often does when YouTube changes its layout), the UI should not crash. Display a clean, styled error message in the skeleton shell.
3. **Cache aggressively.** If we already know the channel name and icon from the user's subscription list, use it instantly on page load to prevent visual pop-in. Don't re-scrape what we already know.

By following these rules, you will help maintain an app that feels snappy, looks polished, and remains highly maintainable.
