const axios = require('axios');
const { google } = require('googleapis');

function getSupabaseServerKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
}

function getGoogleCalendarClient() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const projectId = process.env.GOOGLE_PROJECT_ID;

  if (!calendarId || !clientEmail || !privateKey || !projectId) {
    console.log('REVERSE SYNC SKIPPED: missing calendar configuration');
    return null;
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  return {
    calendarId,
    calendar: google.calendar({ version: 'v3', auth })
  };
}

async function getCalendarLinkedAppointments() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServerKey = getSupabaseServerKey();

  if (!supabaseUrl || !supabaseServerKey) {
    console.log('REVERSE SYNC SKIPPED: missing Supabase configuration');
    return [];
  }

  try {
    const response = await axios.get(
      `${supabaseUrl}/rest/v1/appointments?select=id,customer_name,service,status,google_calendar_event_id&google_calendar_event_id=not.is.null&status=not.eq.cancelled&limit=100`,
      {
        headers: {
          apikey: supabaseServerKey,
          Authorization: `Bearer ${supabaseServerKey}`
        }
      }
    );

    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.log('REVERSE SYNC APPOINTMENT FETCH ERROR:', error.response?.data || error.message);
    return [];
  }
}

async function markAppointmentCancelled(appointment) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServerKey = getSupabaseServerKey();

  try {
    const response = await axios.patch(
      `${supabaseUrl}/rest/v1/appointments?id=eq.${appointment.id}`,
      { status: 'cancelled' },
      {
        headers: {
          apikey: supabaseServerKey,
          Authorization: `Bearer ${supabaseServerKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        }
      }
    );

    console.log('REVERSE SYNC CANCELLED APPOINTMENT:', {
      appointmentId: appointment.id,
      customerName: appointment.customer_name,
      service: appointment.service,
      googleCalendarEventId: appointment.google_calendar_event_id,
      updatedRow: response.data
    });
  } catch (error) {
    console.log('REVERSE SYNC CANCEL PATCH ERROR:', {
      appointmentId: appointment.id,
      error: error.response?.data || error.message
    });
  }
}

async function googleEventExists(client, appointment) {
  const eventId = appointment.google_calendar_event_id;

  if (!eventId) return true;

  try {
    const response = await client.calendar.events.get({
      calendarId: client.calendarId,
      eventId
    });

    return response.data?.status !== 'cancelled';
  } catch (error) {
    const status = error.response?.status || error.code;

    if (status === 404 || status === 410) {
      return false;
    }

    console.log('REVERSE SYNC GOOGLE EVENT CHECK ERROR:', {
      appointmentId: appointment.id,
      googleCalendarEventId: eventId,
      error: error.response?.data || error.message
    });

    return true;
  }
}

async function reconcileDeletedCalendarEvents() {
  const client = getGoogleCalendarClient();

  if (!client) return;

  const appointments = await getCalendarLinkedAppointments();
  let cancelledCount = 0;

  for (const appointment of appointments) {
    const exists = await googleEventExists(client, appointment);

    if (!exists) {
      await markAppointmentCancelled(appointment);
      cancelledCount += 1;
    }
  }

  console.log('REVERSE SYNC COMPLETE:', {
    checked: appointments.length,
    cancelled: cancelledCount
  });
}

module.exports = {
  reconcileDeletedCalendarEvents
};
