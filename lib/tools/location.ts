import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getUserProfile } from "@/lib/stores/user-profile";
import { registerTools } from "./registry";

// Returns the user's last reported browser geolocation, if they've opted in
// from the UI. The agent should call this whenever a request is location-
// dependent ("what's the weather", "find a coffee shop near me", "how long
// to drive home"). It returns a structured JSON payload — never coordinates
// inline in prose. If sharing is disabled the result explains how to enable
// it, so the agent can relay that to the user.
export const getUserLocationTool = tool(
  async () => {
    const profile = getUserProfile();
    if (!profile || profile.location_consent !== 1) {
      return JSON.stringify({
        available: false,
        reason: "user has not enabled location sharing",
        how_to_enable: "Open the Profile panel and toggle 'Share my location'.",
      });
    }
    if (
      typeof profile.location_lat !== "number" ||
      typeof profile.location_lng !== "number"
    ) {
      return JSON.stringify({
        available: false,
        reason: "consent granted but no coordinates reported yet",
        how_to_enable: "Reload the app so the browser can request a fix.",
      });
    }
    const updatedAt = profile.location_updated_at;
    const ageMs = updatedAt ? Date.now() - Date.parse(updatedAt) : null;
    return JSON.stringify({
      available: true,
      lat: profile.location_lat,
      lng: profile.location_lng,
      accuracy_m: profile.location_accuracy_m ?? null,
      label: profile.location_label ?? null,
      updated_at: updatedAt,
      age_seconds: ageMs !== null ? Math.round(ageMs / 1000) : null,
    });
  },
  {
    name: "get_user_location",
    description:
      "Get the user's current geographic location (latitude/longitude) from their browser. Use this whenever the answer depends on where the user is — weather, nearby places, directions home, local time of points-of-interest. Returns { available, lat, lng, accuracy_m, label, age_seconds } or { available: false, reason } if the user hasn't opted in.",
    schema: z.object({}).describe("No arguments — the user's location is stored server-side and updated by the client."),
  },
);

registerTools("Web", [getUserLocationTool]);
