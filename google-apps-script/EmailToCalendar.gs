// =============================================================================
// Configuration - Edit these values to match your setup
// =============================================================================

const CONFIG = {
  // Email filter
  EMAIL_SENDER: "avsandare@example.com",    // Filter emails from this sender
  EMAIL_SUBJECT: "Nästa vecka",              // Filter emails with this subject (partial match)

  // Calendar
  CALENDAR_NAME: "",  // Leave empty to use primary calendar, or set e.g. "Klättring"

  // Event settings
  EVENT_TITLE_PREFIX: "Klättring: ",         // Prefix for calendar event titles
  EVENT_START_HOUR: 17,                      // Default event start time (24h)
  EVENT_START_MINUTE: 30,
  EVENT_DURATION_MINUTES: 90,                // Default event duration

  // Label to mark processed emails
  GMAIL_LABEL: "CalendarProcessed",

  // How many days ahead "next week" means (auto-calculated, but can override)
  // Set to 0 for auto-detect (next Monday from today)
  FORCE_START_DATE: null,  // e.g. "2026-04-06" to force a specific Monday
};

// =============================================================================
// Location database - Map location names to coordinates
// Add your locations here: "Name": { lat: XX.XXXX, lng: YY.YYYY }
// =============================================================================

const LOCATIONS = {
  "Steenen":       { lat: 57.7089, lng: 11.9746, description: "Steenen klätterområde" },
  "Monsterstenen": { lat: 57.7150, lng: 11.9800, description: "Monsterstenen" },
  "Mossberget":    { lat: 57.7200, lng: 11.9700, description: "Mossberget klätterområde" },
  "Vattenfallet":  { lat: 57.7100, lng: 11.9650, description: "Vattenfallet" },
  "Ängen":         { lat: 57.7050, lng: 11.9750, description: "Ängen" },
};

// Swedish weekday names mapped to JS day-of-week offsets from Monday (0-based)
const WEEKDAYS_SV = {
  "måndag":  0,
  "tisdag":  1,
  "onsdag":  2,
  "torsdag": 3,
  "fredag":  4,
  "lördag":  5,
  "söndag":  6,
};

// =============================================================================
// Main entry point - Run this on a time-based trigger (e.g. daily)
// =============================================================================

function processEmails() {
  const label = getOrCreateLabel_(CONFIG.GMAIL_LABEL);
  const query = buildSearchQuery_();

  Logger.log("Searching Gmail with query: " + query);
  const threads = GmailApp.search(query, 0, 10);
  Logger.log("Found " + threads.length + " matching thread(s)");

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const message of messages) {
      if (isAlreadyProcessed_(message, label)) continue;

      Logger.log("Processing email: " + message.getSubject() + " from " + message.getFrom());

      const body = message.getPlainBody();
      const schedule = parseSchedule_(body);

      if (schedule.length === 0) {
        Logger.log("No weekday-location pairs found in email body.");
        continue;
      }

      Logger.log("Parsed schedule: " + JSON.stringify(schedule));

      const nextMonday = getNextMonday_();
      const mapUrls = generateMapUrls_(schedule);
      createCalendarEvents_(schedule, nextMonday, mapUrls);
    }

    // Mark entire thread as processed
    thread.addLabel(label);
  }
}

// =============================================================================
// Email parsing
// =============================================================================

function buildSearchQuery_() {
  let query = "is:unread";
  if (CONFIG.EMAIL_SENDER) {
    query += " from:" + CONFIG.EMAIL_SENDER;
  }
  if (CONFIG.EMAIL_SUBJECT) {
    query += " subject:(" + CONFIG.EMAIL_SUBJECT + ")";
  }
  // Exclude already-processed emails
  query += " -label:" + CONFIG.GMAIL_LABEL;
  return query;
}

function parseSchedule_(body) {
  const schedule = [];
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    // Match patterns like "Måndag: Steenen" or "Måndag - Steenen" or "Måndag  Steenen"
    const match = line.match(
      /^\s*(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)\s*[:;\-–—]\s*(.+)/i
    );
    if (match) {
      const weekday = match[1].toLowerCase();
      const locationName = match[2].trim();
      const dayOffset = WEEKDAYS_SV[weekday];
      const locationData = findLocation_(locationName);

      schedule.push({
        weekday: match[1],           // Original case
        weekdayLower: weekday,
        dayOffset: dayOffset,
        locationName: locationName,
        location: locationData,      // null if not found in LOCATIONS map
      });
    }
  }

  return schedule;
}

function findLocation_(name) {
  // Exact match first
  if (LOCATIONS[name]) return LOCATIONS[name];

  // Case-insensitive match
  for (const key in LOCATIONS) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return LOCATIONS[key];
    }
  }

  // Partial match (location name contains the search term or vice versa)
  for (const key in LOCATIONS) {
    if (key.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(key.toLowerCase())) {
      return LOCATIONS[key];
    }
  }

  Logger.log("WARNING: No coordinates found for location: " + name);
  return null;
}

// =============================================================================
// Map URL generation
// =============================================================================

/**
 * Generates map URLs for the schedule.
 * Returns an object with:
 *   - geojsonUrl: a geojson.io link showing labeled pins (names + weekdays)
 *   - googleMapsUrl: a Google Maps link showing all locations
 */
function generateMapUrls_(schedule) {
  const entries = schedule.filter(e => e.location);
  if (entries.length === 0) return { geojsonUrl: "", googleMapsUrl: "" };

  return {
    geojsonUrl: buildGeojsonIoUrl_(entries),
    googleMapsUrl: buildGoogleMapsUrl_(entries),
  };
}

/**
 * Builds a geojson.io URL that shows an interactive map with labeled pins.
 * Each pin displays the weekday and location name as a popup and as marker text.
 * No API key required — opens directly in the browser.
 */
function buildGeojsonIoUrl_(entries) {
  const features = entries.map(entry => ({
    type: "Feature",
    properties: {
      "marker-color": "#e74c3c",
      "marker-size": "medium",
      "marker-symbol": "",
      title: entry.weekday + ": " + entry.locationName,
      description: entry.location.description || entry.locationName,
    },
    geometry: {
      type: "Point",
      coordinates: [entry.location.lng, entry.location.lat],  // GeoJSON is [lng, lat]
    },
  }));

  const geojson = {
    type: "FeatureCollection",
    features: features,
  };

  // geojson.io accepts GeoJSON as a URL hash in the format:
  // https://geojson.io/#data=data:application/json,<url-encoded-json>
  const encoded = encodeURIComponent(JSON.stringify(geojson));
  return "https://geojson.io/#data=data:application/json," + encoded;
}

/**
 * Builds a Google Maps URL as a fallback (no custom labels, but familiar UI).
 */
function buildGoogleMapsUrl_(entries) {
  if (entries.length === 1) {
    const e = entries[0];
    return "https://www.google.com/maps/search/?api=1&query=" +
           e.location.lat + "," + e.location.lng;
  }

  // Use the /dir/ format for multiple locations (shows all stops on one map)
  const origin = entries[0].location.lat + "," + entries[0].location.lng;
  const destination = entries[entries.length - 1].location.lat + "," + entries[entries.length - 1].location.lng;
  const waypoints = entries.slice(1, -1)
    .map(e => e.location.lat + "," + e.location.lng)
    .join("|");

  let url = "https://www.google.com/maps/dir/?api=1" +
            "&origin=" + origin +
            "&destination=" + destination;

  if (waypoints) {
    url += "&waypoints=" + encodeURIComponent(waypoints);
  }

  return url;
}

function buildMapDescription_(schedule, mapUrls) {
  let desc = "Veckans platser:\n\n";

  for (const entry of schedule) {
    desc += entry.weekday + ": " + entry.locationName;
    if (entry.location) {
      desc += " (GPS: " + entry.location.lat + ", " + entry.location.lng + ")";
    } else {
      desc += " (koordinater saknas)";
    }
    desc += "\n";
  }

  if (mapUrls.geojsonUrl) {
    desc += "\nKarta med namn och veckodagar:\n" + mapUrls.geojsonUrl;
  }
  if (mapUrls.googleMapsUrl) {
    desc += "\n\nGoogle Maps:\n" + mapUrls.googleMapsUrl;
  }

  return desc;
}

// =============================================================================
// Calendar event creation
// =============================================================================

function createCalendarEvents_(schedule, startMonday, mapUrls) {
  const calendar = getCalendar_();
  const fullDescription = buildMapDescription_(schedule, mapUrls);

  for (const entry of schedule) {
    const eventDate = new Date(startMonday);
    eventDate.setDate(eventDate.getDate() + entry.dayOffset);

    const startTime = new Date(eventDate);
    startTime.setHours(CONFIG.EVENT_START_HOUR, CONFIG.EVENT_START_MINUTE, 0, 0);

    const endTime = new Date(startTime);
    endTime.setMinutes(endTime.getMinutes() + CONFIG.EVENT_DURATION_MINUTES);

    const title = CONFIG.EVENT_TITLE_PREFIX + entry.locationName;

    // Build per-event description
    let description = entry.weekday + ": " + entry.locationName + "\n\n";
    if (entry.location) {
      description += "GPS: " + entry.location.lat + ", " + entry.location.lng + "\n";
      description += "Google Maps: https://www.google.com/maps/search/?api=1&query=" +
                     entry.location.lat + "," + entry.location.lng + "\n\n";
    }
    description += "---\n" + fullDescription;

    // Check for existing event to avoid duplicates
    const existing = calendar.getEvents(startTime, endTime, { search: CONFIG.EVENT_TITLE_PREFIX });
    const isDuplicate = existing.some(e => e.getTitle() === title);

    if (isDuplicate) {
      Logger.log("Skipping duplicate event: " + title + " on " + startTime);
      continue;
    }

    const event = calendar.createEvent(title, startTime, endTime, {
      description: description,
      location: entry.locationName +
        (entry.location ? " (" + entry.location.lat + ", " + entry.location.lng + ")" : ""),
    });

    Logger.log("Created event: " + title + " on " + startTime + " (ID: " + event.getId() + ")");
  }
}

function getCalendar_() {
  if (CONFIG.CALENDAR_NAME) {
    const calendars = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
    if (calendars.length > 0) return calendars[0];
    Logger.log("Calendar '" + CONFIG.CALENDAR_NAME + "' not found, using primary.");
  }
  return CalendarApp.getDefaultCalendar();
}

// =============================================================================
// Date utilities
// =============================================================================

function getNextMonday_() {
  if (CONFIG.FORCE_START_DATE) {
    return new Date(CONFIG.FORCE_START_DATE + "T00:00:00");
  }

  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);

  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);

  Logger.log("Next Monday: " + nextMonday);
  return nextMonday;
}

// =============================================================================
// Gmail utilities
// =============================================================================

function getOrCreateLabel_(labelName) {
  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    label = GmailApp.createLabel(labelName);
    Logger.log("Created Gmail label: " + labelName);
  }
  return label;
}

function isAlreadyProcessed_(message, label) {
  // We check at thread level via label, but this is a safety check
  const thread = message.getThread();
  const labels = thread.getLabels();
  return labels.some(l => l.getName() === label.getName());
}

// =============================================================================
// Setup & utility functions
// =============================================================================

/**
 * Run this once to set up the time-based trigger.
 * It will run processEmails() every day at 8-9 AM.
 */
function setupTrigger() {
  // Remove existing triggers for this function
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === "processEmails") {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Create new daily trigger
  ScriptApp.newTrigger("processEmails")
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log("Trigger set up: processEmails will run daily at 8-9 AM");
}

/**
 * Test function - parse a sample email body without actually creating events.
 */
function testParsing() {
  const sampleBody = `
Hej alla!

Nästa vecka går vi till följande:

Måndag: Steenen
Tisdag: Monsterstenen
Onsdag: Mossberget
Torsdag: Vattenfallet
Fredag: Ängen

Ses där!
  `;

  const schedule = parseSchedule_(sampleBody);
  Logger.log("Parsed schedule:");
  for (const entry of schedule) {
    Logger.log("  " + entry.weekday + " -> " + entry.locationName +
               (entry.location ? " @ " + entry.location.lat + "," + entry.location.lng : " (no coords)"));
  }

  const mapUrls = generateMapUrls_(schedule);
  Logger.log("GeoJSON map (with labels): " + mapUrls.geojsonUrl);
  Logger.log("Google Maps (fallback):    " + mapUrls.googleMapsUrl);

  const description = buildMapDescription_(schedule, mapUrls);
  Logger.log("Event description:\n" + description);
}

/**
 * List all known locations and their coordinates.
 */
function listLocations() {
  Logger.log("Known locations:");
  for (const name in LOCATIONS) {
    const loc = LOCATIONS[name];
    Logger.log("  " + name + ": " + loc.lat + ", " + loc.lng +
               (loc.description ? " (" + loc.description + ")" : ""));
  }
}
