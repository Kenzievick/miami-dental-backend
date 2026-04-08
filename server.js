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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/book-appointment', async (req, res) => {
  const { name, phone, date, time, service } = req.body;

  if (!name || !phone || !date || !time || !service) {
    return res.status(400).json({ error: 'Missing required fields: name, phone, date, time, service' });
  }

  const startDateTime = new Date(`${date}T${time}`);
  if (isNaN(startDateTime.getTime())) {
    return res.status(400).json({ error: 'Invalid date or time format. Use YYYY-MM-DD for date and HH:MM for time.' });
  }

  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour duration

  const event = {
    summary: `${service} - ${name}`,
    description: `Appointment Details:\nPatient: ${name}\nPhone: ${phone}\nService: ${service}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: 'America/New_York',
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: 'America/New_York',
    },
  };

  try {
    const calendar = getCalendarClient();
    const response = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      resource: event,
    });

    res.json({
      success: true,
      message: 'Appointment booked successfully',
      event: {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start.dateTime,
        end: response.data.end.dateTime,
        htmlLink: response.data.htmlLink,
      },
    });
  } catch (err) {
    console.error('Google Calendar error:', err.message);
    res.status(500).json({ error: 'Failed to create calendar event', details: err.message });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
