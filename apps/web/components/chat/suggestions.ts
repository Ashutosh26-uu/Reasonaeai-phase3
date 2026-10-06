/**
 * AI-suggested next actions and enhancements.
 *
 * Appears dynamically when a run or checkpoint completes, offering 4 compact
 * and practical next steps across key product dimensions (AI features, Design,
 * New feature, Reliability).
 */

export interface PromptSuggestion {
  /** Category taxonomy matching Google AI Studio style badges. */
  category: "ai" | "design" | "feature" | "quality";
  /** User-visible badge text (e.g. "✨ AI Features", "Design", "New feature", "Reliability"). */
  categoryLabel: string;
  /** Icon key for the faint watermark and visual accent. */
  icon: "sparkles" | "design" | "feature" | "quality";
  /** Stable identifier for the suggestion card. */
  id: string;
  /** Complete prompt populated into the composer on selection. */
  prompt: string;
  /** Actionable short title displayed on the bubble (e.g. "Add lyric hover effects"). */
  title: string;
}

export interface SuggestionContext {
  /** The final text response produced by the CTO. */
  assistantText?: string | undefined;
  /** Files modified or created in the latest checkpoint. */
  checkpointFiles?:
    | Array<{ path: string; status?: string | undefined }>
    | undefined;
  /** Project name if available. */
  projectName?: string | undefined;
  /** Rotation seed for cycling alternatives via refresh. */
  seed?: number | undefined;
  /** The user prompt that triggered the completed run. */
  userPrompt?: string | undefined;
}

type Domain =
  | "audio"
  | "dashboard"
  | "commerce"
  | "productivity"
  | "auth"
  | "chat"
  | "game"
  | "general";

interface DomainTemplates {
  ai: Array<{ title: string; prompt: string }>;
  design: Array<{ title: string; prompt: string }>;
  feature: Array<{ title: string; prompt: string }>;
  quality: Array<{ title: string; prompt: string }>;
}

const DOMAIN_TEMPLATES: Record<Domain, DomainTemplates> = {
  audio: {
    ai: [
      {
        prompt:
          "Add AI capabilities to generate real-time lyrics translations, chord progressions, and song mood analysis for tracks.",
        title: "Add AI lyrics translation & chords",
      },
      {
        prompt:
          "Integrate an AI recommendation engine that suggests matching tracks and playlists based on audio tempo, genre, and user listening history.",
        title: "Add smart audio recommendations",
      },
      {
        prompt:
          "Add an AI DJ feature that announces upcoming tracks, provides artist trivia, and transitions smoothly between songs.",
        title: "Add AI voice narration & DJ voice",
      },
    ],
    design: [
      {
        prompt:
          "Add lyric hover effects with smooth line highlighting, karaoke-style active sync glow, and auto-scrolling to the current verse.",
        title: "Add lyric hover effects",
      },
      {
        prompt:
          "Style the album artwork with a spinning vinyl record animation on play, smooth needle drop motion, and ambient color glow matching the cover.",
        title: "Add animated vinyl album art disc",
      },
      {
        prompt:
          "Add a sleek floating mini-player bar at the bottom with backdrop blur, volume slider popover, and compact track scrubber.",
        title: "Add dark glassmorphic mini-player bar",
      },
    ],
    feature: [
      {
        prompt:
          "Add an interactive audio frequency visualizer with animated waveforms that react to playback and allow click-to-seek scrubbing.",
        title: "Add progress audio visualizer",
      },
      {
        prompt:
          "Implement an interactive playback queue drawer with drag-and-drop reordering, track removal, and loop/shuffle toggles.",
        title: "Add playlist queue & drag reordering",
      },
      {
        prompt:
          "Add a multi-band equalizer panel with audio presets (bass boost, vocal, acoustic) and variable playback speed controls (0.5x to 2x).",
        title: "Add audio equalizer & speed controls",
      },
    ],
    quality: [
      {
        prompt:
          "Add robust error boundaries, audio loading retry with fallback stream URLs, and user notifications when playback fails.",
        title: "Add audio playback error recovery",
      },
      {
        prompt:
          "Implement audio caching using IndexedDB and Service Worker for offline playback of recently played tracks.",
        title: "Add offline caching for tracks",
      },
      {
        prompt:
          "Write comprehensive unit and integration tests covering play, pause, seek, playlist queue transitions, and volume persistence.",
        title: "Add unit tests for player state",
      },
    ],
  },
  auth: {
    ai: [
      {
        prompt:
          "Integrate AI security scoring that detects suspicious login locations or device changes and triggers step-up verification.",
        title: "Add AI risk-based authentication",
      },
      {
        prompt:
          "Add an intelligent real-time password evaluator that provides tailored security guidance and warns against common breached patterns.",
        title: "Add AI password strength coach",
      },
      {
        prompt:
          "Implement smart account detection that suggests the user's previously used sign-in provider (e.g. 'You usually sign in with GitHub').",
        title: "Add smart sign-in method recommendation",
      },
    ],
    design: [
      {
        prompt:
          "Refine authentication inputs with smooth floating labels, clear validation icons, and clean dark-mode input focus rings.",
        title: "Add animated floating label form inputs",
      },
      {
        prompt:
          "Add an accessible password visibility toggle with smooth eye icon transition and caps-lock warning banner.",
        title: "Add password show/hide eye toggle",
      },
      {
        prompt:
          "Add branded glassmorphic OAuth buttons for Google, GitHub, and Apple with loading spinner states on click.",
        title: "Add social login pill buttons",
      },
    ],
    feature: [
      {
        prompt:
          "Implement Two-Factor Authentication with QR code setup, authenticator app verification code entry, and emergency recovery codes.",
        title: "Add 2-Factor Authentication (TOTP)",
      },
      {
        prompt:
          "Build a secure email-based magic link and password reset request flow with rate-limited resend countdown timer.",
        title: "Add password reset & magic link flow",
      },
      {
        prompt:
          "Add a security settings tab showing active logged-in sessions with device, IP, and location, plus 'Sign out all devices' button.",
        title: "Add active sessions & device management",
      },
    ],
    quality: [
      {
        prompt:
          "Enforce strict CSRF token validation and HTTP-only, SameSite=Lax cookie policies on all authentication endpoints.",
        title: "Add CSRF protection & strict cookies",
      },
      {
        prompt:
          "Implement progressive IP and username rate limiting with lockouts to defend against credential stuffing and brute-force attacks.",
        title: "Add brute-force rate limiting",
      },
      {
        prompt:
          "Write automated tests verifying expired token rejection, session revocation, invalid credential messaging, and successful login.",
        title: "Add automated auth flow regression tests",
      },
    ],
  },
  chat: {
    ai: [
      {
        prompt:
          "Integrate real-time AI reply suggestions above the chat input that generate 3 contextual quick-reply options for messages.",
        title: "Add AI reply suggestions & autocomplete",
      },
      {
        prompt:
          "Add a 'Summarize unread messages' button that condenses long active chat discussions into bullet points with key decisions.",
        title: "Add AI thread summarizer",
      },
      {
        prompt:
          "Provide an AI writing helper in the message draft to rephrase messages for clarity, friendliness, or professional tone.",
        title: "Add sentiment & tone adjustment",
      },
    ],
    design: [
      {
        prompt:
          "Design a smooth pulsating 3-dot typing indicator bubble with avatar and timestamp for active interlocutors.",
        title: "Add animated typing bubbles indicator",
      },
      {
        prompt:
          "Add a floating emoji reaction popover on message hover with reaction counter badges and click-to-react toggles.",
        title: "Add message reactions emoji picker",
      },
      {
        prompt:
          "Style recorded voice notes with compact interactive waveforms, play/pause buttons, and elapsed duration counters.",
        title: "Add voice message audio waveform preview",
      },
    ],
    feature: [
      {
        prompt:
          "Support image and document drag-and-drop into chat, thumbnail previews, upload progress bars, and full-screen lightbox viewing.",
        title: "Add rich media attachments & drag-drop",
      },
      {
        prompt:
          "Implement instant search across conversation history with keyword highlighting, jump-to-message navigation, and date filters.",
        title: "Add message search with highlight match",
      },
      {
        prompt:
          "Add threaded conversation replies with quoted message previews above the composer for clear conversational context.",
        title: "Add reply-in-thread & quoted messages",
      },
    ],
    quality: [
      {
        prompt:
          "Implement robust WebSocket reconnection with exponential backoff and message delivery receipts (sent, delivered, read).",
        title: "Add WebSocket reconnect with backoff",
      },
      {
        prompt:
          "Audit and sanitize markdown rendering to prevent XSS while safely preserving code blocks and link formatting.",
        title: "Add message sanitization & XSS defenses",
      },
      {
        prompt:
          "Write integration tests verifying chat virtualized list scrolling performance, message deduplication, and out-of-order delivery handling.",
        title: "Add stress tests for rapid message streams",
      },
    ],
  },
  commerce: {
    ai: [
      {
        prompt:
          "Integrate AI-driven 'Frequently bought together' and personalized product recommendations based on cart contents and browsing history.",
        title: "Add AI product recommendations",
      },
      {
        prompt:
          "Add an AI review summary badge that extracts key pros and cons from customer reviews into quick digestible bullet points.",
        title: "Add AI review summarizer",
      },
      {
        prompt:
          "Implement an AI visual search feature allowing shoppers to upload a photo to find visually similar catalog products.",
        title: "Add visual search & image matching",
      },
    ],
    design: [
      {
        prompt:
          "Enhance product image galleries with smooth pinch/hover magnification, thumbnail carousels, and responsive swipe navigation.",
        title: "Add product gallery zoom & carousel",
      },
      {
        prompt:
          "Build a sleek slide-over shopping cart drawer with item count animations, free shipping progress bar, and checkout CTA.",
        title: "Add slide-over cart drawer with badges",
      },
      {
        prompt:
          "Add glowing badge pills for 'Low stock', 'Best seller', and 'Limited offer' with subtle micro-animations to drive engagement.",
        title: "Add badge pills for stock & discounts",
      },
    ],
    feature: [
      {
        prompt:
          "Add multi-facet sidebar filtering for price range, size, color, brand, and customer rating with URL query state persistence.",
        title: "Add multi-attribute filters & sorting",
      },
      {
        prompt:
          "Implement a persistent wishlist feature with one-click heart toggles, local storage fallback, and move-to-cart actions.",
        title: "Add wishlist & saved for later",
      },
      {
        prompt:
          "Add a discount promo code input with real-time validation, percentage/fixed savings calculation, and clear order breakdown.",
        title: "Add coupon code validation & discount calculation",
      },
    ],
    quality: [
      {
        prompt:
          "Add optimistic cart validation and server-side stock verification to prevent checkout of out-of-stock items.",
        title: "Add inventory race-condition validation",
      },
      {
        prompt:
          "Add resilient payment processing error handling, declining card feedback, and idempotent order creation.",
        title: "Add payment gateway fallback handlers",
      },
      {
        prompt:
          "Write end-to-end integration tests covering cart addition, coupon application, address entry, and order completion.",
        title: "Add e-commerce checkout flow tests",
      },
    ],
  },
  dashboard: {
    ai: [
      {
        prompt:
          "Integrate AI anomaly detection that flags unusual spikes or drops in dashboard metrics and generates automated root-cause summaries.",
        title: "Add AI anomaly detection on metrics",
      },
      {
        prompt:
          "Add an AI-powered search bar where users can query dashboard data using plain English (e.g. 'Show revenue by region last month').",
        title: "Add natural language data querying",
      },
      {
        prompt:
          "Add a one-click AI feature that analyzes active metrics and charts to generate a concise bullet-point briefing for executives.",
        title: "Add automated executive summary report",
      },
    ],
    design: [
      {
        prompt:
          "Enhance charts with rich animated tooltips, crosshair inspection cursors, and custom color palettes with dark mode contrast.",
        title: "Add interactive chart hover tooltips",
      },
      {
        prompt:
          "Implement a customizable dashboard grid allowing users to resize, reorder, and collapse metric widgets with smooth layout transitions.",
        title: "Add customizable drag-and-drop widget grid",
      },
      {
        prompt:
          "Add subtle skeleton loading animations for charts and metric cards, plus a live indicator pulse whenever data refreshes.",
        title: "Add skeleton loading & live data pulse",
      },
    ],
    feature: [
      {
        prompt:
          "Add a flexible date range filter (today, last 7 days, custom range) with previous-period comparison percentage badges.",
        title: "Add date range picker & comparisons",
      },
      {
        prompt:
          "Add an export dropdown allowing users to download dashboard tables as CSV and export rendered charts as formatted PDF reports.",
        title: "Add CSV and PDF export for reports",
      },
      {
        prompt:
          "Allow users to set custom threshold alerts on key metrics with email or webhook notifications when targets are breached.",
        title: "Add metric alerts & webhook triggers",
      },
    ],
    quality: [
      {
        prompt:
          "Add SWR or React Query caching with stale-while-revalidate strategy to make dashboard navigation instantaneous.",
        title: "Add data caching & optimistic refresh",
      },
      {
        prompt:
          "Implement isolated error cards for failed widget queries with retry buttons, preserving the rest of the healthy dashboard.",
        title: "Add error states for broken endpoints",
      },
      {
        prompt:
          "Write unit and component tests verifying number formatting, percentage change calculations, and edge cases with zero data.",
        title: "Add component tests for metric cards",
      },
    ],
  },
  game: {
    ai: [
      {
        prompt:
          "Integrate an AI procedural generation algorithm that creates endless varied game levels with dynamic difficulty scaling.",
        title: "Add AI procedural level generator",
      },
      {
        prompt:
          "Implement a state-machine or AI decision-tree opponent that adapts its strategy based on the player's recent actions.",
        title: "Add intelligent NPC opponent behavior",
      },
      {
        prompt:
          "Add an AI commentator that narrates clutch moments, game milestones, and player achievements with humorous commentary.",
        title: "Add AI commentary & dynamic narration",
      },
    ],
    design: [
      {
        prompt:
          "Add dynamic canvas particle effects for collisions, score increments, and smooth camera screen-shake on impacts.",
        title: "Add screen-shake & particle impact effects",
      },
      {
        prompt:
          "Create an optional retro arcade filter with subtle scanlines, CRT screen curve, and neon color bloom effects.",
        title: "Add retro CRT scanline & glow shader",
      },
      {
        prompt:
          "Design a game-over and victory modal with high-score badges, animated star ratings, and celebratory particle confetti.",
        title: "Add victory fanfare banner & confetti",
      },
    ],
    feature: [
      {
        prompt:
          "Add a high-score leaderboard storing top scores in localStorage with player initials, ranks, and shareable score cards.",
        title: "Add local & global high-score leaderboard",
      },
      {
        prompt:
          "Integrate Web Audio API sound effects (jump, hit, powerup, victory) with background music loop and mute toggles.",
        title: "Add sound effects synthesizer & volume mixer",
      },
      {
        prompt:
          "Implement on-screen virtual d-pad and action buttons for smooth playability on smartphones and touch devices.",
        title: "Add touch controls for mobile screens",
      },
    ],
    quality: [
      {
        prompt:
          "Refactor the game loop with delta-time calculations and object pooling to guarantee rock-solid 60 FPS without stutter.",
        title: "Add 60 FPS requestAnimationFrame loop tuning",
      },
      {
        prompt:
          "Add window blur listener that automatically pauses game state to prevent unintended deaths when switching tabs.",
        title: "Add pause menu & auto-pause on window blur",
      },
      {
        prompt:
          "Write unit tests verifying bounding-box and ray-cast collision edge cases, boundary wrapping, and score accrual.",
        title: "Add collision detection precision tests",
      },
    ],
  },
  general: {
    ai: [
      {
        prompt:
          "Add AI-powered assistance to analyze data, generate smart recommendations, and provide instant insights for this app.",
        title: "Add AI capabilities and integrations to your app",
      },
      {
        prompt:
          "Add an AI command bar where users can execute complex actions across the app by typing plain language instructions.",
        title: "Add natural language command assistant",
      },
      {
        prompt:
          "Integrate an AI summarizer that extracts key takeaways and highlights important changes in records or documents.",
        title: "Add AI automatic content summarizer",
      },
    ],
    design: [
      {
        prompt:
          "Implement a seamless dark and light theme toggle with system preference detection, smooth CSS transitions, and persisted state.",
        title: "Add dark & light theme switcher",
      },
      {
        prompt:
          "Create a clean mobile navigation drawer with touch gestures, accessible backdrop dismissal, and smooth spring animations.",
        title: "Add responsive mobile navigation drawer",
      },
      {
        prompt:
          "Add polished hover states, active press physics, skeleton loaders, and subtle border highlights across all interactive elements.",
        title: "Add micro-interactions & feedback states",
      },
    ],
    feature: [
      {
        prompt:
          "Add a global CMD+K command palette and keyboard navigation shortcuts for frequent workflows with a cheat-sheet modal.",
        title: "Add keyboard shortcuts & command palette",
      },
      {
        prompt:
          "Add one-click export functionality allowing users to download their data as formatted JSON or CSV files.",
        title: "Add export data to CSV & JSON",
      },
      {
        prompt:
          "Implement an action history stack allowing users to undo and redo edits with CMD+Z and CMD+Shift+Z shortcuts.",
        title: "Add undo & redo history management",
      },
    ],
    quality: [
      {
        prompt:
          "Write comprehensive unit and component tests with Vitest covering core user workflows, error states, and edge cases.",
        title: "Add automated unit & component tests",
      },
      {
        prompt:
          "Add strict form validation schemas, friendly user error messages, and top-level React error boundaries with reload options.",
        title: "Add input validation & error boundaries",
      },
      {
        prompt:
          "Implement dynamic code splitting and lazy component loading to minimize initial page load times and boost performance.",
        title: "Optimize bundle size & lazy loading",
      },
    ],
  },
  productivity: {
    ai: [
      {
        prompt:
          "Add an AI button on tasks that automatically generates actionable subtasks, time estimates, and required resources.",
        title: "Add AI task breakdown & subtasks",
      },
      {
        prompt:
          "Integrate an AI scheduling helper that analyzes deadlines and dependencies to recommend optimal daily task priorities.",
        title: "Add smart priority & schedule assistant",
      },
      {
        prompt:
          "Add a feature where pasting raw notes generates structured action items with assignees, tags, and deadlines.",
        title: "Add AI meeting notes & action item extractor",
      },
    ],
    design: [
      {
        prompt:
          "Add a responsive Kanban board view with smooth drag-and-drop card movements between columns and column count badges.",
        title: "Add Kanban drag-and-drop board view",
      },
      {
        prompt:
          "Implement a CMD+K command palette and keyboard shortcuts (e.g. 'N' for new task, 'E' to edit) for rapid navigation.",
        title: "Add keyboard navigation & quick command palette",
      },
      {
        prompt:
          "Add a satisfying confetti or checkmark burst micro-animation with sound effects when completing high-priority items.",
        title: "Add completion celebration micro-animation",
      },
    ],
    feature: [
      {
        prompt:
          "Add multi-tag color-coded chips, fuzzy keyword search, and saved custom filter views for quick retrieval.",
        title: "Add tag filtering & full-text search",
      },
      {
        prompt:
          "Implement recurring task rules (daily, weekly, custom intervals) with browser push notifications for upcoming deadlines.",
        title: "Add recurring tasks & reminder dates",
      },
      {
        prompt:
          "Support rich Markdown formatting in task descriptions with interactive checklist checkboxes and code snippet syntax highlighting.",
        title: "Add Markdown notes & checklist preview",
      },
    ],
    quality: [
      {
        prompt:
          "Implement offline task creation and updates using localStorage/IndexedDB, automatically syncing when connection restores.",
        title: "Add offline mode with sync queue",
      },
      {
        prompt:
          "Make task completion and deletion feel instantaneous with optimistic UI state and an 'Undo' toast notification.",
        title: "Add optimistic UI updates & undo toast",
      },
      {
        prompt:
          "Write unit tests verifying date sorting, status transitions, multi-tag filtering combinations, and persistence.",
        title: "Add tests for task filters & sorting",
      },
    ],
  },
};

interface DomainRule {
  domain: Domain;
  filePatterns: RegExp[];
  patterns: RegExp[];
}

const DOMAIN_RULES: DomainRule[] = [
  {
    domain: "audio",
    filePatterns: [
      /audio|music|lyrics|playlist|soundtrack|equalizer|synth|bpm|mp3|wav|flac|karaoke/i,
      /(?:^|[\\/])(?:audio|sound|player|visualizer|synth)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:audio|music|lyrics?|playlist|soundtrack|synthesizer|equalizer|album|turntable|visualizer|tempo|bpm|mp3|wav|flac|karaoke|chords?|tuner)\b/i,
      /\b(?:audio player|music player|audio track|sound effects?|audio visualizer)\b/i,
    ],
  },
  {
    domain: "game",
    filePatterns: [
      /game|arcade|sprite|physics|collision|canvas-game/i,
      /(?:^|[\\/])(?:game|sprite|physics)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:game|arcade|gameplay|scoreboard|leaderboard|high-score|sprites?|spritesheet|physics engine|collision detection|canvas game|platformer|tetris|snake|pong|d-pad|joystick)\b/i,
      /\b(?:2-player|multiplayer|player score|game over|level up|fps loop)\b/i,
    ],
  },
  {
    domain: "auth",
    filePatterns: [
      /auth|login|signin|signup|session|credential|oauth|jwt|totp|password/i,
      /(?:^|[\\/])(?:auth|login|signin|signup|session)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:auth|authentication|oauth|jwt|totp|2fa|mfa|login|signin|sign-in|signup|sign-up|passwords?|credentials?|sessions?|rbac|magic link|reset password)\b/i,
    ],
  },
  {
    domain: "dashboard",
    filePatterns: [
      /dashboard|analytics|metrics|timeseries|telemetry|kpi/i,
      /(?:^|[\\/])(?:dashboard|metrics|analytics|chart)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:dashboard|analytics|kpis?|metrics|timeseries|telemetry|data visualization|widget grid|reporting)\b/i,
      /\b(?:bar chart|line chart|pie chart|chart component|charts?)\b/i,
    ],
  },
  {
    domain: "commerce",
    filePatterns: [
      /commerce|cart|checkout|storefront|catalog|stripe|payment|product/i,
      /(?:^|[\\/])(?:cart|checkout|store|commerce|product)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:ecommerce|e-commerce|storefront|shopping cart|checkout|products?|catalog|stripe|payment gateway|inventory|sku|shopify|wishlist)\b/i,
      /\b(?:order summary|place order|discount code|coupon code|promo code|add to cart)\b/i,
    ],
  },
  {
    domain: "chat",
    filePatterns: [
      /chat|message|thread|inbox|conversation/i,
      /(?:^|[\\/])(?:chat|message|thread|inbox)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:chat|messaging|direct message|dm|dms|channels?|typing indicator|unread messages?)\b/i,
      /\b(?:chat room|message thread|conversation thread|quoted message|emoji reactions?)\b/i,
    ],
  },
  {
    domain: "productivity",
    filePatterns: [
      /kanban|todo|checklist|agenda|planner/i,
      /(?:^|[\\/])(?:kanban|todo|checklist|planner)[^\\/]*\.[a-z0-9]+$/i,
    ],
    patterns: [
      /\b(?:kanban|todos?|task management|task tracker|task list|checklist|agendas?|deadlines?|planners?|organizers?|trello|jira)\b/i,
      /\b(?:subtasks?|due dates?|calendar events?|meeting notes?)\b/i,
    ],
  },
];

function sanitizeAssistantText(text: string): string {
  return text
    .replace(/in order to/gi, " ")
    .replace(/(?:completed|finished) (?:the|this) task/gi, " ")
    .replace(/(?:task|build) (?:completed|finished|succeeded)/gi, " ")
    .replace(/graphql/gi, "api")
    .replace(/(?:sse |event-|readable )?stream(?:ing)?/gi, " ")
    .replace(/note that/gi, " ")
    .replace(/please note/gi, " ")
    .replace(/border(?:-radius|-color)?/gi, " ")
    .replace(/recorder/gi, "audio-capture");
}

/**
 * Detects the application domain using a weighted multi-signal scoring model
 * that balances user prompt intent, project name, checkpoint file paths, and
 * sanitized assistant output.
 */
export function detectDomain(context: SuggestionContext): Domain {
  const userPrompt = (context.userPrompt ?? "").toLowerCase();
  const projectName = (context.projectName ?? "").toLowerCase();
  const sanitizedAssistant = sanitizeAssistantText(
    context.assistantText ?? ""
  ).toLowerCase();
  // Bound inspection to first 50 files for predictable runtime
  const checkpointPaths = (context.checkpointFiles ?? [])
    .slice(0, 50)
    .map((file) => file.path.toLowerCase());

  let bestDomain: Domain = "general";
  let maxScore = 0;

  for (const rule of DOMAIN_RULES) {
    let score = 0;

    // 1. User prompt intent (primary signal, weight 4)
    if (rule.patterns.some((re) => re.test(userPrompt))) {
      score += 4;
    }

    // 2. Project name intent (weight 4)
    if (rule.patterns.some((re) => re.test(projectName))) {
      score += 4;
    }

    // 3. Checkpoint files (weight up to 4)
    const matchingFiles = checkpointPaths.filter((path) =>
      rule.filePatterns.some((re) => re.test(path))
    );
    if (matchingFiles.length > 0) {
      score += Math.min(matchingFiles.length * 2, 4);
    }

    // 4. Assistant text (supplementary signal, weight 1)
    if (rule.patterns.some((re) => re.test(sanitizedAssistant))) {
      score += 1;
    }

    if (score > maxScore) {
      maxScore = score;
      bestDomain = rule.domain;
    }
  }

  // Threshold: require at least score 2 to depart from general suggestions
  return maxScore >= 2 ? bestDomain : "general";
}

/**
 * Dynamically generates 4 practical, contextual suggestions across the 4 key
 * categories (AI Features, Design, New feature, Reliability).
 */
export function generatePromptSuggestions(
  context: SuggestionContext
): PromptSuggestion[] {
  const domain = detectDomain(context);
  const templates = DOMAIN_TEMPLATES[domain] ?? DOMAIN_TEMPLATES.general;
  const seed = Math.max(0, Math.floor(context.seed ?? 0));

  // Determine category items using modulo seed for rotation without duplicates
  const aiIndex = seed % templates.ai.length;
  const designIndex = seed % templates.design.length;
  const featureIndex = seed % templates.feature.length;
  const qualityIndex = seed % templates.quality.length;

  const fallbackItem = {
    prompt: "Add new enhancements and features to this project.",
    title: "Enhance project capabilities",
  };

  const aiItem = templates.ai[aiIndex] ?? templates.ai[0] ?? fallbackItem;
  const designItem =
    templates.design[designIndex] ?? templates.design[0] ?? fallbackItem;
  const featureItem =
    templates.feature[featureIndex] ?? templates.feature[0] ?? fallbackItem;
  const qualityItem =
    templates.quality[qualityIndex] ?? templates.quality[0] ?? fallbackItem;

  return [
    {
      category: "ai",
      categoryLabel: "✨ AI Features",
      icon: "sparkles",
      id: `sugg-ai-${domain}-${aiIndex}`,
      prompt: aiItem.prompt,
      title: aiItem.title,
    },
    {
      category: "design",
      categoryLabel: "Design",
      icon: "design",
      id: `sugg-design-${domain}-${designIndex}`,
      prompt: designItem.prompt,
      title: designItem.title,
    },
    {
      category: "feature",
      categoryLabel: "New feature",
      icon: "feature",
      id: `sugg-feature-${domain}-${featureIndex}`,
      prompt: featureItem.prompt,
      title: featureItem.title,
    },
    {
      category: "quality",
      categoryLabel: "Reliability",
      icon: "quality",
      id: `sugg-quality-${domain}-${qualityIndex}`,
      prompt: qualityItem.prompt,
      title: qualityItem.title,
    },
  ];
}
