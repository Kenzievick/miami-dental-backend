require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

// Parse a date string in YYYY-MM-DD or natural language (e.g. "April 11", "Saturday April 11")
// Returns a YYYY-MM-DD string, or null if unparseable
function parseDate(input) {
  if (!input) return null;

  const trimmed = input.trim();

  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Strip leading day-of-week if present (e.g. "Saturday April 11" → "April 11")
  const stripped = trimmed.replace(
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/i,
    ''
  );

  // Detect if a year was explicitly included
  const hasYear = /\d{4}/.test(stripped);
  const dateStr = hasYear ? stripped : `${stripped} ${new Date().getFullYear()}`;

  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;

  // If no year was given and the date is already in the past, roll to next year
  if (!hasYear) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (parsed < today) parsed.setFullYear(parsed.getFullYear() + 1);
  }

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Convert a local date + hour/minute in a given timezone to a UTC Date
function localToUTC(dateStr, hour, minute, timezone) {
  const pad = (n) => String(n).padStart(2, '0');
  const localStr = `${dateStr}T${pad(hour)}:${pad(minute)}:00`;

  const approx = new Date(localStr + 'Z');

  const tzFormatted = approx.toLocaleString('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const tzDate = new Date(tzFormatted.replace(', ', 'T') + 'Z');
  const offsetMs = approx - tzDate;

  return new Date(approx.getTime() + offsetMs);
}

// Format a UTC Date as a readable time string in the given timezone (e.g. "9:00 AM")
function formatTime(utcDate, timezone) {
  return utcDate.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/current-date', (req, res) => {
  const today = new Date();
  const formatted = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  res.json({ date: formatted });
});

app.get('/check-availability', async (req, res) => {
  console.log('[check-availability] incoming request:');
  console.log('  query params:', JSON.stringify(req.query, null, 2));
  console.log('  headers:', JSON.stringify(req.headers, null, 2));

  const { date, timezone } = req.query;

  if (!date) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: date. Accepts YYYY-MM-DD or natural language like "April 11" or "Saturday April 11".',
    });
  }

  const parsedDate = parseDate(date);
  if (!parsedDate) {
    return res.status(400).json({
      success: false,
      error: `Could not parse date: "${date}". Try formats like "2026-04-11", "April 11", or "Saturday April 11".`,
    });
  }

  const tz = timezone || 'America/New_York';

  console.log(`[check-availability] raw="${date}" parsed="${parsedDate}" tz="${tz}"`);

  // Determine day of week using noon UTC to avoid DST boundary issues
  const dayOfWeek = new Date(`${parsedDate}T12:00:00Z`).getUTCDay(); // 0=Sun, 6=Sat

  if (dayOfWeek === 0) {
    return res.json({
      success: true,
      date: parsedDate,
      timezone: tz,
      available: { slots_30min: [], slots_60min: [] },
      message: 'No availability on Sundays.',
    });
  }

  const isSaturday = dayOfWeek === 6;
  const startHour = isSaturday ? 9 : 8;
  const endHour   = isSaturday ? 14 : 18;

  const dayStart = localToUTC(parsedDate, 0, 0, tz);
  const dayEnd   = localToUTC(parsedDate, 23, 59, tz);

  try {
    const calendar = getCalendarClient();

    const freebusyRes = await calendar.freebusy.query({
      resource: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        timeZone: tz,
        items: [{ id: process.env.GOOGLE_CALENDAR_ID }],
      },
    });

    const busyPeriods = (
      freebusyRes.data.calendars[process.env.GOOGLE_CALENDAR_ID]?.busy || []
    ).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));

    const workEnd = localToUTC(parsedDate, endHour, 0, tz);

    const overlaps = (slotStart, slotEnd) =>
      busyPeriods.some((b) => slotStart < b.end && slotEnd > b.start);

    const slots30 = [];
    const slots60 = [];

    const totalMinutes = (endHour - startHour) * 60;

    for (let offset = 0; offset < totalMinutes; offset += 30) {
      const hour   = startHour + Math.floor(offset / 60);
      const minute = offset % 60;

      const slotStart = localToUTC(parsedDate, hour, minute, tz);
      const slotEnd30 = new Date(slotStart.getTime() + 30 * 60 * 1000);
      const slotEnd60 = new Date(slotStart.getTime() + 60 * 60 * 1000);

      if (slotEnd30 <= workEnd && !overlaps(slotStart, slotEnd30)) {
        slots30.push({
          start:     formatTime(slotStart, tz),
          end:       formatTime(slotEnd30, tz),
          start_iso: slotStart.toISOString(),
          end_iso:   slotEnd30.toISOString(),
        });
      }

      if (slotEnd60 <= workEnd && !overlaps(slotStart, slotEnd60)) {
        slots60.push({
          start:     formatTime(slotStart, tz),
          end:       formatTime(slotEnd60, tz),
          start_iso: slotStart.toISOString(),
          end_iso:   slotEnd60.toISOString(),
        });
      }
    }

    res.json({
      success: true,
      date: parsedDate,
      timezone: tz,
      day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
      hours: `${formatTime(localToUTC(parsedDate, startHour, 0, tz), tz)} – ${formatTime(workEnd, tz)}`,
      available: {
        slots_30min: slots30,
        slots_60min: slots60,
      },
    });
  } catch (err) {
    console.error('Google Calendar error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Failed to check availability.',
      details: err.message,
    });
  }
});

app.post('/book-appointment', async (req, res) => {
  console.log('[book-appointment] incoming request:');
  console.log('  body:', JSON.stringify(req.body, null, 2));
  console.log('  headers:', JSON.stringify(req.headers, null, 2));

  const { name, phone, email, date, time, service, timezone } = req.body;

  // Validate required fields
  const missingFields = [];
  if (!name)    missingFields.push('name');
  if (!phone)   missingFields.push('phone');
  if (!email)   missingFields.push('email');
  if (!date)    missingFields.push('date');
  if (!time)    missingFields.push('time');
  if (!service) missingFields.push('service');

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Missing required fields: ${missingFields.join(', ')}`,
    });
  }

  const tz = timezone || 'America/New_York';

  const startDateTime = new Date(`${date}T${time}`);
  if (isNaN(startDateTime.getTime())) {
    return res.status(400).json({
      success: false,
      error: 'Invalid date or time format. Use YYYY-MM-DD for date and HH:MM for time.',
    });
  }

  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

  const event = {
    summary: `${service} - ${name}`,
    description: `Patient: ${name}\nPhone: ${phone}\nEmail: ${email}\nService: ${service}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: tz,
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: tz,
    },
    attendees: [{ email }],
  };

  try {
    const calendar = getCalendarClient();
    const response = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      sendUpdates: 'all',
      resource: event,
    });

    res.json({
      success: true,
      message: `Appointment booked successfully. A calendar invite has been sent to ${email}.`,
      event: {
        id:        response.data.id,
        summary:   response.data.summary,
        start:     response.data.start.dateTime,
        end:       response.data.end.dateTime,
        timezone:  tz,
        attendees: response.data.attendees?.map((a) => a.email) || [],
        htmlLink:  response.data.htmlLink,
      },
    });
  } catch (err) {
    console.error('Google Calendar error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Failed to create calendar event.',
      details: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
