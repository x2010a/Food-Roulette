// Food Roulette settings
window.FR_CONFIG = {
  // Address of your Cloudflare Worker (see README → "Google places").
  // Example: "https://food-roulette.yourname.workers.dev"
  // Leave empty ("") to run on free data only.
  googleProxy: "https://food-roulette.normanangyewjun-ocs.workers.dev",

  // Cloudflare Turnstile *site* key (the public one) for the human check.
  // Leave empty if you haven't set TURNSTILE_SECRET on the Worker.
  turnstileSiteKey: "0x4AAAAAAF2JvLxy7vko6CJr",
};
