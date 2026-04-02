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

  // Google My Map ID — used to fetch locations via KML export
  // From: https://www.google.com/maps/d/viewer?mid=1MAmmlfBC9qNeqYU-UkCRMMcBhMM
  MY_MAP_ID: "1MAmmlfBC9qNeqYU-UkCRMMcBhMM",

  // Static Maps image dimensions
  STATIC_MAP_WIDTH: 600,
  STATIC_MAP_HEIGHT: 400,

  // How many days ahead "next week" means (auto-calculated, but can override)
  FORCE_START_DATE: null,  // e.g. "2026-04-06" to force a specific Monday
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

// Marker colors for each weekday (Google Static Maps named colors)
const WEEKDAY_COLORS = {
  "måndag":  "red",
  "tisdag":  "blue",
  "onsdag":  "green",
  "torsdag": "purple",
  "fredag":  "yellow",
  "lördag":  "orange",
  "söndag":  "gray",
};

// =============================================================================
// API key — stored securely in Script Properties
// =============================================================================

/**
 * Retrieves the Google Maps API key from Script Properties.
 * Set it once via: setupApiKey("your-key-here") or manually in
 * Project Settings > Script Properties > GOOGLE_MAPS_API_KEY
 */
function getApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty("GOOGLE_MAPS_API_KEY");
  if (!key) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY not found in Script Properties. " +
      "Run setupApiKey('your-key') or add it in Project Settings > Script Properties."
    );
  }
  return key;
}

/**
 * One-time helper to store your API key securely.
 * Run from the editor: setupApiKey("AIza...")
 * After running, delete the call from your code so the key isn't in source.
 */
function setupApiKey(key) {
  PropertiesService.getScriptProperties().setProperty("GOOGLE_MAPS_API_KEY", key);
  Logger.log("API key stored in Script Properties.");
}

// =============================================================================
// Location loading from Google My Maps (KML)
// =============================================================================

/**
 * Fetches all placemarks from the shared Google My Map and returns them
 * as a name->location map: { "Steenen": { lat: 57.xx, lng: 11.xx, description: "..." }, ... }
 *
 * The KML export URL format is:
 *   https://www.google.com/maps/d/kml?mid=MAP_ID&forcekml=1
 */
function fetchLocationsFromMyMap_() {
  const url = "https://www.google.com/maps/d/kml?mid=" + CONFIG.MY_MAP_ID + "&forcekml=1";
  Logger.log("Fetching KML from: " + url);

  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error("Failed to fetch KML (HTTP " + response.getResponseCode() + "). " +
                    "Make sure the map is shared publicly or with 'anyone with the link'.");
  }

  const kml = response.getContentText();
  return parseKml_(kml);
}

/**
 * Parses KML XML and extracts placemarks into a locations map.
 * KML placemarks look like:
 *   <Placemark>
 *     <name>Steenen</name>
 *     <description>Some description</description>
 *     <Point><coordinates>11.9746,57.7089,0</coordinates></Point>
 *   </Placemark>
 */
function parseKml_(kml) {
  const doc = XmlService.parse(kml);
  const root = doc.getRootElement();
  const kmlNs = root.getNamespace();

  const locations = {};
  const placemarks = findElements_(root, "Placemark", kmlNs);

  for (const pm of placemarks) {
    const nameEl = pm.getChild("name", kmlNs);
    const descEl = pm.getChild("description", kmlNs);
    const pointEl = pm.getChild("Point", kmlNs);

    if (!nameEl || !pointEl) continue;

    const coordsEl = pointEl.getChild("coordinates", kmlNs);
    if (!coordsEl) continue;

    // KML coordinates are "lng,lat,altitude"
    const parts = coordsEl.getText().trim().split(",");
    if (parts.length < 2) continue;

    const name = nameEl.getText().trim();
    locations[name] = {
      lat: parseFloat(parts[1]),
      lng: parseFloat(parts[0]),
      description: descEl ? descEl.getText().trim() : name,
    };

    Logger.log("  Loaded location: " + name + " (" + parts[1] + ", " + parts[0] + ")");
  }

  Logger.log("Loaded " + Object.keys(locations).length + " locations from My Map.");
  return locations;
}

/**
 * Recursively finds all elements with a given tag name in the KML document.
 * Needed because KML can nest Placemarks inside Folders/Documents.
 */
function findElements_(element, tagName, namespace) {
  let results = [];
  const children = element.getChildren();
  for (const child of children) {
    if (child.getName() === tagName) {
      results.push(child);
    }
    results = results.concat(findElements_(child, tagName, namespace));
  }
  return results;
}

// =============================================================================
// Location matching
// =============================================================================

/**
 * Finds a location by name in the locations map.
 * Tries exact match, then case-insensitive, then partial/fuzzy.
 */
function findLocation_(name, locations) {
  // Exact match
  if (locations[name]) return { key: name, ...locations[name] };

  // Case-insensitive match
  for (const key in locations) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return { key: key, ...locations[key] };
    }
  }

  // Partial match (one contains the other)
  for (const key in locations) {
    if (key.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(key.toLowerCase())) {
      return { key: key, ...locations[key] };
    }
  }

  Logger.log("WARNING: No coordinates found for location: " + name);
  return null;
}

// =============================================================================
// Main entry point - Run this on a time-based trigger (e.g. daily)
// =============================================================================

function processEmails() {
  // Load locations from the shared Google My Map
  const locations = fetchLocationsFromMyMap_();

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
      const schedule = parseSchedule_(body, locations);

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

function parseSchedule_(body, locations) {
  const schedule = [];
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    // Match patterns like "Måndag: Steenen" or "Måndag - Steenen" or "Måndag – Steenen"
    const match = line.match(
      /^\s*(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)\s*[:;\-–—]\s*(.+)/i
    );
    if (match) {
      const weekday = match[1].toLowerCase();
      const locationName = match[2].trim();
      const dayOffset = WEEKDAYS_SV[weekday];
      const locationData = findLocation_(locationName, locations);

      schedule.push({
        weekday: match[1],           // Original case
        weekdayLower: weekday,
        dayOffset: dayOffset,
        locationName: locationName,
        location: locationData,      // null if not found
      });
    }
  }

  return schedule;
}

// =============================================================================
// Map URL generation
// =============================================================================

/**
 * Generates map URLs for the schedule.
 * Returns an object with:
 *   - staticMapUrl: Google Maps Static API image URL with labeled pins
 *   - googleMapsUrl: interactive Google Maps link with all locations
 */
function generateMapUrls_(schedule) {
  const entries = schedule.filter(e => e.location);
  if (entries.length === 0) return { staticMapUrl: "", googleMapsUrl: "" };

  return {
    staticMapUrl: buildStaticMapUrl_(entries),
    googleMapsUrl: buildGoogleMapsUrl_(entries),
  };
}

/**
 * Builds a Google Maps Static API URL with colored, labeled markers.
 * Each weekday gets a different color and a letter label (M, T, O, T, F).
 * The label shows the first letter of the weekday.
 *
 * Requires a valid API key in Script Properties.
 * Enable "Maps Static API" in your Google Cloud Console.
 */
function buildStaticMapUrl_(entries) {
  const apiKey = getApiKey_();

  // Build one marker group per entry (each can have its own color + label)
  const markerParams = entries.map(entry => {
    const color = WEEKDAY_COLORS[entry.weekdayLower] || "red";
    const label = entry.weekday.charAt(0).toUpperCase();
    return "markers=color:" + color +
           "%7Clabel:" + label +
           "%7C" + entry.location.lat + "," + entry.location.lng;
  });

  const url = "https://maps.googleapis.com/maps/api/staticmap" +
    "?size=" + CONFIG.STATIC_MAP_WIDTH + "x" + CONFIG.STATIC_MAP_HEIGHT +
    "&maptype=roadmap" +
    "&" + markerParams.join("&") +
    "&key=" + apiKey;

  return url;
}

/**
 * Builds an interactive Google Maps URL showing all locations.
 */
function buildGoogleMapsUrl_(entries) {
  if (entries.length === 1) {
    const e = entries[0];
    return "https://www.google.com/maps/search/?api=1&query=" +
           e.location.lat + "," + e.location.lng;
  }

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

  if (mapUrls.staticMapUrl) {
    desc += "\nKarta (bild):\n" + mapUrls.staticMapUrl;
  }
  if (mapUrls.googleMapsUrl) {
    desc += "\n\nInteraktiv karta:\n" + mapUrls.googleMapsUrl;
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

  ScriptApp.newTrigger("processEmails")
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log("Trigger set up: processEmails will run daily at 8-9 AM");
}

/**
 * Test: fetch and list all locations from the shared Google My Map.
 * Run this first to verify the KML import works.
 */
function testFetchLocations() {
  const locations = fetchLocationsFromMyMap_();
  Logger.log("=== Locations from My Map ===");
  for (const name in locations) {
    const loc = locations[name];
    Logger.log("  " + name + ": " + loc.lat + ", " + loc.lng +
               (loc.description ? " — " + loc.description : ""));
  }
}

/**
 * Test: parse a sample email and generate map URLs (without creating events).
 */
function testParsing() {
  const locations = fetchLocationsFromMyMap_();

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

  const schedule = parseSchedule_(sampleBody, locations);
  Logger.log("=== Parsed schedule ===");
  for (const entry of schedule) {
    Logger.log("  " + entry.weekday + " -> " + entry.locationName +
               (entry.location ? " @ " + entry.location.lat + "," + entry.location.lng : " (no coords)"));
  }

  const mapUrls = generateMapUrls_(schedule);
  Logger.log("\nStatic map image: " + mapUrls.staticMapUrl);
  Logger.log("\nInteractive map:  " + mapUrls.googleMapsUrl);

  const description = buildMapDescription_(schedule, mapUrls);
  Logger.log("\n=== Event description ===\n" + description);
}
