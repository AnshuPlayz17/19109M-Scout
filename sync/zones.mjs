// Event days, 8am to 6pm in the event's own time zone (RobotEvents dates have no useful
// end time). RobotEvents gives a region and country but no zone, so look the zone up.
const ZONES = {
  // US states
  "Connecticut": "America/New_York", "Delaware": "America/New_York", "District of Columbia": "America/New_York", "Florida": "America/New_York",
  "Georgia": "America/New_York", "Indiana": "America/Indiana/Indianapolis", "Maine": "America/New_York", "Maryland": "America/New_York",
  "Massachusetts": "America/New_York", "Michigan": "America/Detroit", "New Hampshire": "America/New_York", "New Jersey": "America/New_York",
  "New York": "America/New_York", "North Carolina": "America/New_York", "Ohio": "America/New_York", "Pennsylvania": "America/New_York",
  "Rhode Island": "America/New_York", "South Carolina": "America/New_York", "Vermont": "America/New_York", "Virginia": "America/New_York",
  "West Virginia": "America/New_York", "Kentucky": "America/New_York",
  "Alabama": "America/Chicago", "Arkansas": "America/Chicago", "Illinois": "America/Chicago", "Iowa": "America/Chicago",
  "Kansas": "America/Chicago", "Louisiana": "America/Chicago", "Minnesota": "America/Chicago", "Mississippi": "America/Chicago",
  "Missouri": "America/Chicago", "Nebraska": "America/Chicago", "North Dakota": "America/Chicago", "Oklahoma": "America/Chicago",
  "South Dakota": "America/Chicago", "Tennessee": "America/Chicago", "Texas": "America/Chicago", "Wisconsin": "America/Chicago",
  "Arizona": "America/Phoenix", "Colorado": "America/Denver", "Idaho": "America/Boise", "Montana": "America/Denver",
  "New Mexico": "America/Denver", "Utah": "America/Denver", "Wyoming": "America/Denver",
  "California": "America/Los_Angeles", "Nevada": "America/Los_Angeles", "Oregon": "America/Los_Angeles", "Washington": "America/Los_Angeles",
  "Alaska": "America/Anchorage", "Hawaii": "Pacific/Honolulu", "Puerto Rico": "America/Puerto_Rico",
  // Canadian provinces
  "Ontario": "America/Toronto", "Quebec": "America/Toronto", "Québec": "America/Toronto", "Manitoba": "America/Winnipeg",
  "Saskatchewan": "America/Regina", "Alberta": "America/Edmonton", "British Columbia": "America/Vancouver",
  "Nova Scotia": "America/Halifax", "New Brunswick": "America/Halifax", "Prince Edward Island": "America/Halifax",
  "Newfoundland and Labrador": "America/St_Johns",
};
const COUNTRY_ZONES = {
  "China": "Asia/Shanghai", "Taiwan": "Asia/Taipei", "Hong Kong": "Asia/Hong_Kong", "Japan": "Asia/Tokyo", "Korea": "Asia/Seoul",
  "Singapore": "Asia/Singapore", "Malaysia": "Asia/Kuala_Lumpur", "Philippines": "Asia/Manila", "Vietnam": "Asia/Ho_Chi_Minh",
  "Thailand": "Asia/Bangkok", "Indonesia": "Asia/Jakarta", "India": "Asia/Kolkata", "United Arab Emirates": "Asia/Dubai",
  "Saudi Arabia": "Asia/Riyadh", "Qatar": "Asia/Qatar", "Turkey": "Europe/Istanbul", "United Kingdom": "Europe/London",
  "Ireland": "Europe/Dublin", "Spain": "Europe/Madrid", "France": "Europe/Paris", "Germany": "Europe/Berlin", "Mexico": "America/Mexico_City",
  "Colombia": "America/Bogota", "Brazil": "America/Sao_Paulo", "Chile": "America/Santiago", "Argentina": "America/Argentina/Buenos_Aires",
  "New Zealand": "Pacific/Auckland", "Australia": "Australia/Sydney", "Egypt": "Africa/Cairo", "South Africa": "Africa/Johannesburg",
};
export const eventZone = e => ZONES[e.location?.region ?? e.region] || COUNTRY_ZONES[e.location?.country ?? e.country] || "America/Toronto";
const localDay = (t, zone) => new Date(t).toLocaleDateString("en-CA", { timeZone: zone });
const localHour = (t, zone) => Number(new Date(t).toLocaleString("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }));
export function liveNow(e, t) {
  const zone = eventZone(e), day = localDay(t, zone), hour = localHour(t, zone);
  return day >= localDay(Date.parse(e.start), zone) && day <= localDay(Date.parse(e.end || e.start), zone) && hour >= 8 && hour < 18;
}
