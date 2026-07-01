const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const { Resend } = require('resend');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getSupabaseServerKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
}

function getDefaultDemoConfig() {
  return {
    business_name: 'Wade and Me Barbershop',
    owner_name: 'Wade',
    appointment_actions: 'schedule, cancel, or reschedule an appointment'
  };
}

async function loadDemoConfig() {
  const defaultDemoConfig = getDefaultDemoConfig();
  const supabaseServerKey = getSupabaseServerKey();

  if (!process.env.SUPABASE_URL || !supabaseServerKey) {
    return defaultDemoConfig;
  }

  try {
    const response = await axios.get(
      `${process.env.SUPABASE_URL}/rest/v1/demo_config?select=*&limit=1`,
      {
        headers: {
          apikey: supabaseServerKey,
          Authorization: `Bearer ${supabaseServerKey}`
        }
      }
    );

    return {
      ...defaultDemoConfig,
      ...(response.data?.[0] || {})
    };
  } catch (error) {
    console.log('LOAD DEMO CONFIG ERROR:', error.response?.data || error.message);
    return defaultDemoConfig;
  }
}

function buildDemoGreeting(demoConfig) {
  const config = {
    ...getDefaultDemoConfig(),
    ...(demoConfig || {})
  };

  return `Thanks for calling ${config.business_name}. I can help ${config.appointment_actions}, or take a message for ${config.owner_name}. How can I help you today?`;
}

function getSessionCallerId(req) {
  return req.body.CallSid || req.body.From || 'unknown';
}

function getCallerPhone(req) {
  return req.body.From || 'unknown';
}

function gatherTwiml(message) {
  const safeMessage = escapeXml(message);

  return `
<Response>
  <Gather input="speech" action="/gather" method="POST" timeout="4" speechTimeout="1.5">
    <Say voice="Polly.Joanna">${safeMessage}</Say>
  </Gather>
  <Redirect method="POST">/voice-repeat</Redirect>
</Response>
`;
}

function hangupTwiml(message, demoConfig) {
  const config = {
    ...getDefaultDemoConfig(),
    ...(demoConfig || {})
  };
  const safeMessage = escapeXml(message);
  const safeBusinessName = escapeXml(config.business_name);

  return `
<Response>
  <Say voice="Polly.Joanna">${safeMessage} Thanks for calling ${safeBusinessName}.</Say>
  <Hangup/>
</Response>
`;
}

function isTerminalState(state) {
  return ['booked', 'cancelled', 'rescheduled', 'message_saved', 'ended'].includes(state);
}

async function callSupabaseRpc(functionName, payload) {
  const response = await axios.post(
    `${process.env.SUPABASE_URL}/rest/v1/rpc/${functionName}`,
    payload,
    {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

async function getAppointmentById(appointmentId) {
  if (!appointmentId) return null;

  const supabaseServerKey = getSupabaseServerKey();

  try {
    const response = await axios.get(
      `${process.env.SUPABASE_URL}/rest/v1/appointments?id=eq.${appointmentId}&select=*`,
      {
        headers: {
          apikey: supabaseServerKey,
          Authorization: `Bearer ${supabaseServerKey}`
        }
      }
    );

    return response.data?.[0] || null;
  } catch (error) {
    console.log('GET APPOINTMENT ERROR:', error.response?.data || error.message);
    return null;
  }
}

async function updateAppointmentCalendarEventId(appointmentId, googleCalendarEventId) {
  if (!appointmentId || !googleCalendarEventId) {
    console.log('CALENDAR EVENT ID UPDATE SKIPPED:', { appointmentId, googleCalendarEventId });
    return;
  }

  const supabaseServerKey = getSupabaseServerKey();

  try {
    const response = await axios.patch(
      `${process.env.SUPABASE_URL}/rest/v1/appointments?id=eq.${appointmentId}`,
      { google_calendar_event_id: googleCalendarEventId },
      {
        headers: {
          apikey: supabaseServerKey,
          Authorization: `Bearer ${supabaseServerKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        }
      }
    );

    console.log('GOOGLE CALENDAR EVENT ID SAVED:', {
      appointmentId,
      googleCalendarEventId,
      savedRow: response.data
    });
  } catch (error) {
    console.log('SAVE GOOGLE CALENDAR EVENT ID ERROR:', error.response?.data || error.message);
  }
}

async function updateCallSessionState(sessionId, currentState, collected) {
  if (!sessionId || !currentState) {
    console.log('SESSION UPDATE SKIPPED:', { sessionId, currentState });
    return;
  }

  const supabaseServerKey = getSupabaseServerKey();

  try {
    await axios.patch(
      `${process.env.SUPABASE_URL}/rest/v1/call_sessions?id=eq.${sessionId}`,
      {
        current_state: currentState,
        collected,
        updated_at: new Date().toISOString()
      },
      {
        headers: {
          apikey: supabaseServerKey,
          Authorization: `Bearer ${supabaseServerKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('SESSION STATE UPDATED:', { sessionId, currentState, collected });
  } catch (error) {
    console.log('SESSION STATE UPDATE ERROR:', error.response?.data || error.message);
  }
}

function removeCollectedKeys(collected, keys) {
  const next = { ...(collected || {}) };

  for (const key of keys) {
    delete next[key];
  }

  return next;
}

async function sendSms(to, body) {
  if (!to || !process.env.TWILIO_FROM_NUMBER || to === 'unknown') {
    console.log('SMS SKIPPED:', { to, body });
    return;
  }

  try {
    const message = await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body
    });

    console.log('SMS SENT:', message.sid);
  } catch (error) {
    console.log('SMS ERROR:', error.message);
  }
}

async function sendOwnerEmail(subject, text) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!resendApiKey || !ownerEmail) {
    console.log('EMAIL SKIPPED:', {
      hasResendKey: Boolean(resendApiKey),
      ownerEmail
    });
    return;
  }

  try {
    const resend = new Resend(resendApiKey);

    const result = await resend.emails.send({
      from: 'Wade Scheduler <onboarding@resend.dev>',
      to: ownerEmail,
      subject,
      text
    });

    console.log('EMAIL SENT:', result.data?.id || result.id || result);
  } catch (error) {
    console.log('EMAIL ERROR:', error.message);
  }
}

function formatServiceForText(service) {
  if (!service) return 'appointment';
  return String(service).replace(/_/g, ' ');
}

function addThirtyMinutes(timeValue) {
  const [hourText, minuteText] = String(timeValue).split(':');
  const date = new Date(Date.UTC(2000, 0, 1, Number(hourText), Number(minuteText), 0));

  date.setUTCMinutes(date.getUTCMinutes() + 30);

  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}

function getGoogleCalendarConfig() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const projectId = process.env.GOOGLE_PROJECT_ID;

  if (!calendarId || !clientEmail || !privateKey || !projectId) {
    console.log('CALENDAR SKIPPED:', {
      hasCalendarId: Boolean(calendarId),
      hasClientEmail: Boolean(clientEmail),
      hasPrivateKey: Boolean(privateKey),
      hasProjectId: Boolean(projectId)
    });

    return null;
  }

  return { calendarId, clientEmail, privateKey, projectId };
}

function getGoogleCalendarClient() {
  const config = getGoogleCalendarConfig();

  if (!config) return null;

  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  return {
    calendarId: config.calendarId,
    calendar: google.calendar({ version: 'v3', auth })
  };
}

function buildDateTime(date, time) {
  return `${date}T${time}:00`;
}

function timeToMinutes(timeValue) {
  const [hourText, minuteText] = String(timeValue).split(':');
  return Number(hourText) * 60 + Number(minuteText);
}

function minutesToTime(minutesValue) {
  const hours = String(Math.floor(minutesValue / 60)).padStart(2, '0');
  const minutes = String(minutesValue % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatTimeValueForSpeech(timeValue) {
  const [hourText, minuteText] = String(timeValue).split(':');
  const date = new Date(Date.UTC(2000, 0, 1, Number(hourText), Number(minuteText), 0));

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC'
  }).format(date);
}

function formatAvailableTimesForSpeech(times) {
  const formatted = times.map(formatTimeValueForSpeech);

  if (formatted.length === 1) return formatted[0];
  if (formatted.length === 2) return `${formatted[0]} and ${formatted[1]}`;

  return `${formatted.slice(0, -1).join(', ')}, and ${formatted[formatted.length - 1]}`;
}

function getBusinessTimeWindow(dateText) {
  const date = parseLocalDate(dateText);

  if (!date) return null;

  const day = date.getUTCDay();

  if (day >= 2 && day <= 5) {
    return {
      openTime: '08:00',
      closeTime: '19:00'
    };
  }

  if (day === 6) {
    return {
      openTime: '07:00',
      closeTime: '19:00'
    };
  }

  return null;
}

function calendarEventOverlapsSlot(event, date, slotStartTime, slotEndTime) {
  if (!event || event.status === 'cancelled') return false;

  if (event.start?.date && event.end?.date) {
    return event.start.date <= date && event.end.date > date;
  }

  if (!event.start?.dateTime || !event.end?.dateTime) return false;

  const slotStart = new Date(`${buildDateTime(date, slotStartTime)}-04:00`);
  const slotEnd = new Date(`${buildDateTime(date, slotEndTime)}-04:00`);
  const eventStart = new Date(event.start.dateTime);
  const eventEnd = new Date(event.end.dateTime);

  return eventStart < slotEnd && eventEnd > slotStart;
}

function buildCalendarRequestBody(collected, callerPhone) {
  const name = collected?.name || collected?.customer_name || 'Customer';
  const service = formatServiceForText(collected?.service);
  const date = collected?.resolved_date;
  const time = collected?.time;

  if (!date || !time) return null;

  const endTime = addThirtyMinutes(time);

  return {
    summary: `${name} - ${service}`,
    description: `Booked by Wade Scheduler\nCustomer: ${name}\nService: ${service}\nCaller: ${callerPhone}`,
    start: {
      dateTime: buildDateTime(date, time),
      timeZone: 'America/New_York'
    },
    end: {
      dateTime: buildDateTime(date, endTime),
      timeZone: 'America/New_York'
    }
  };
}

function parseLocalDate(dateText) {
  if (!dateText) return null;

  const [year, month, day] = String(dateText).split('-').map(Number);

  if (!year || !month || !day) return null;

  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysToDateText(dateText, days) {
  const date = parseLocalDate(dateText);

  if (!date) return null;

  date.setUTCDate(date.getUTCDate() + days);

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function formatDateForSpeech(dateText) {
  const date = parseLocalDate(dateText);

  if (!date) return null;

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function formatTimeForSpeech(dateTimeText) {
  if (!dateTimeText) return null;

  const date = new Date(dateTimeText);

  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York'
  }).format(date);
}

function getGoogleCalendarEventRange(event) {
  if (!event) return null;

  if (event.start?.date && event.end?.date) {
    const startDate = event.start.date;
    const inclusiveEndDate = addDaysToDateText(event.end.date, -1);

    if (!startDate || !inclusiveEndDate) return null;

    return {
      startDate,
      endDate: inclusiveEndDate
    };
  }

  if (event.start?.dateTime && event.end?.dateTime) {
    const startDate = event.start.dateTime.slice(0, 10);
    const endDate = event.end.dateTime.slice(0, 10);

    if (!startDate || !endDate) return null;

    return { startDate, endDate };
  }

  return null;
}

function getGoogleCalendarEventTimeRange(event) {
  if (!event?.start?.dateTime || !event?.end?.dateTime) return null;

  const startText = formatTimeForSpeech(event.start.dateTime);
  const endText = formatTimeForSpeech(event.end.dateTime);

  if (!startText || !endText) return null;

  return { startText, endText };
}

function buildFullDayBlockMessage(blockInfo, fallbackMessage) {
  const range = getGoogleCalendarEventRange(blockInfo?.event);

  if (!range) return fallbackMessage;

  const startText = formatDateForSpeech(range.startDate);
  const endText = formatDateForSpeech(range.endDate);

  if (!startText || !endText) return fallbackMessage;

  if (range.startDate === range.endDate) {
    return `Wade is unavailable on ${startText}. What other day works?`;
  }

  return `Wade is out ${startText} through ${endText}. What other day works?`;
}

function buildTimeRangeBlockMessage(blockInfo, fallbackMessage) {
  const availableTimes = blockInfo?.availableTimes || [];

  if (availableTimes.length === 1) {
    return `Wade is unavailable then. The next available time is ${formatAvailableTimesForSpeech(availableTimes)}. Does that work?`;
  }

  if (availableTimes.length > 1) {
    return `Wade is unavailable then. The next three openings are ${formatAvailableTimesForSpeech(availableTimes)}. Which would you like?`;
  }

  const range = getGoogleCalendarEventTimeRange(blockInfo?.event);

  if (range) {
    return `Wade is unavailable from ${range.startText} to ${range.endText} that day. Wade is fully booked for the rest of that day. What other day works for you?`;
  }

  return fallbackMessage || 'Wade is fully booked for the rest of that day. What other day works for you?';
}

async function getGoogleCalendarFullDayBlock(collected) {
  const client = getGoogleCalendarClient();

  if (!client) {
    console.log('GOOGLE FULL-DAY CHECK SKIPPED: missing calendar config');
    return { blocked: false };
  }

  const date = collected?.resolved_date;

  if (!date) {
    console.log('GOOGLE FULL-DAY CHECK SKIPPED: missing date', collected);
    return { blocked: false };
  }

  try {
    const response = await client.calendar.events.list({
      calendarId: client.calendarId,
      timeMin: date + 'T00:00:00-04:00',
      timeMax: date + 'T23:59:59-04:00',
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];

    const fullDayBlock = events.find((event) => {
      if (event.status === 'cancelled') return false;

      if (event.start?.date && event.end?.date) {
        return event.start.date <= date && event.end.date > date;
      }

      if (event.start?.dateTime && event.end?.dateTime) {
        const businessOpen = new Date(date + 'T08:00:00-04:00');
        const businessClose = new Date(date + 'T19:00:00-04:00');
        const eventStart = new Date(event.start.dateTime);
        const eventEnd = new Date(event.end.dateTime);

        return eventStart <= businessOpen && eventEnd >= businessClose;
      }

      return false;
    });

    if (fullDayBlock) {
      console.log('GOOGLE FULL-DAY BLOCK FOUND:', {
        date,
        event: {
          id: fullDayBlock.id,
          summary: fullDayBlock.summary,
          start: fullDayBlock.start,
          end: fullDayBlock.end
        }
      });

      return {
        blocked: true,
        event: fullDayBlock
      };
    }

    console.log('GOOGLE FULL-DAY BLOCK NOT FOUND:', { date });
    return { blocked: false };
  } catch (error) {
    console.log('GOOGLE FULL-DAY CHECK ERROR:', error.response?.data || error.message);
    return { blocked: false };
  }
}

async function getGoogleCalendarSlotBlock(collected) {
  const client = getGoogleCalendarClient();

  if (!client) {
    console.log('GOOGLE AVAILABILITY CHECK SKIPPED: missing calendar config');
    return { blocked: false };
  }

  const date = collected?.resolved_date;
  const time = collected?.time;
  const businessWindow = getBusinessTimeWindow(date);

  if (!date || !time || !businessWindow) {
    console.log('GOOGLE AVAILABILITY CHECK SKIPPED: missing date, time, or business window', collected);
    return { blocked: false };
  }

  const requestedEndTime = addThirtyMinutes(time);

  let excludeEventId = collected?.google_calendar_event_id || null;

  if (!excludeEventId && collected?.reschedule_appointment_id) {
    const existingAppointment = await getAppointmentById(collected.reschedule_appointment_id);
    excludeEventId = existingAppointment?.google_calendar_event_id || null;
  }

  try {
    const response = await client.calendar.events.list({
      calendarId: client.calendarId,
      timeMin: `${buildDateTime(date, time)}-04:00`,
      timeMax: `${buildDateTime(date, businessWindow.closeTime)}-04:00`,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = (response.data.items || []).filter((event) => {
      if (event.status === 'cancelled') return false;
      if (excludeEventId && event.id === excludeEventId) return false;
      return true;
    });

    const blockingEvents = events.filter((event) => {
      return calendarEventOverlapsSlot(event, date, time, requestedEndTime);
    });

    if (blockingEvents.length === 0) {
      console.log('GOOGLE CALENDAR SLOT AVAILABLE:', {
        date,
        time,
        endTime: requestedEndTime
      });

      return { blocked: false };
    }

    const availableTimes = [];
    const closeMinutes = timeToMinutes(businessWindow.closeTime);
    let cursorMinutes = timeToMinutes(time) + 30;

    while (cursorMinutes + 30 <= closeMinutes && availableTimes.length < 3) {
      const slotStartTime = minutesToTime(cursorMinutes);
      const slotEndTime = minutesToTime(cursorMinutes + 30);

      const slotBlocked = events.some((event) => {
        return calendarEventOverlapsSlot(event, date, slotStartTime, slotEndTime);
      });

      if (!slotBlocked) {
        availableTimes.push(slotStartTime);
      }

      cursorMinutes += 30;
    }

    console.log('GOOGLE CALENDAR SLOT BLOCKED:', {
      date,
      time,
      endTime: requestedEndTime,
      availableTimes,
      blockingEvents: blockingEvents.map((event) => ({
        id: event.id,
        summary: event.summary,
        start: event.start,
        end: event.end
      }))
    });

    return {
      blocked: true,
      event: blockingEvents[0],
      availableTimes
    };
  } catch (error) {
    console.log('GOOGLE AVAILABILITY CHECK ERROR:', error.response?.data || error.message);
    return { blocked: false };
  }
}

async function createCalendarEvent(collected, callerPhone) {
  const client = getGoogleCalendarClient();

  if (!client) return null;

  const requestBody = buildCalendarRequestBody(collected, callerPhone);

  if (!requestBody) {
    console.log('CALENDAR CREATE SKIPPED: missing date or time', collected);
    return null;
  }

  try {
    const event = await client.calendar.events.insert({
      calendarId: client.calendarId,
      requestBody
    });

    console.log('CALENDAR EVENT CREATED:', event.data.id);
    return event.data.id;
  } catch (error) {
    console.log('CALENDAR CREATE ERROR:', error.response?.data || error.message);
    return null;
  }
}

async function updateCalendarEvent(eventId, collected, callerPhone) {
  if (!eventId) {
    console.log('CALENDAR UPDATE SKIPPED: missing event id');
    return false;
  }

  const client = getGoogleCalendarClient();

  if (!client) return false;

  const requestBody = buildCalendarRequestBody(collected, callerPhone);

  if (!requestBody) {
    console.log('CALENDAR UPDATE SKIPPED: missing date or time', collected);
    return false;
  }

  try {
    const event = await client.calendar.events.update({
      calendarId: client.calendarId,
      eventId,
      requestBody
    });

    console.log('CALENDAR EVENT UPDATED:', event.data.id);
    return true;
  } catch (error) {
    console.log('CALENDAR UPDATE ERROR:', error.response?.data || error.message);
    return false;
  }
}

async function deleteCalendarEvent(eventId) {
  if (!eventId) {
    console.log('CALENDAR DELETE SKIPPED: missing event id');
    return;
  }

  const client = getGoogleCalendarClient();

  if (!client) return;

  try {
    await client.calendar.events.delete({
      calendarId: client.calendarId,
      eventId
    });

    console.log('CALENDAR EVENT DELETED:', eventId);
  } catch (error) {
    console.log('CALENDAR DELETE ERROR:', error.response?.data || error.message);
  }
}

async function syncCalendarAfterSchedulerTurn(currentState, collected, callerPhone) {
  if (currentState === 'booked') {
    const appointmentId = collected?.appointment_id;
    const eventId = await createCalendarEvent(collected, callerPhone);

    if (appointmentId && eventId) {
      await updateAppointmentCalendarEventId(appointmentId, eventId);
    }

    return;
  }

 if (currentState === 'rescheduled') {
  const appointmentId = collected?.reschedule_appointment_id;
  const appointment = await getAppointmentById(appointmentId);
  const eventId = collected?.google_calendar_event_id || appointment?.google_calendar_event_id;

  const calendarCollected = {
    ...collected,
    name: collected?.name || appointment?.customer_name,
    customer_name: collected?.customer_name || appointment?.customer_name,
    service: collected?.service || appointment?.service
  };

  if (eventId) {
    const updated = await updateCalendarEvent(
      eventId,
      calendarCollected,
      callerPhone
    );

    if (updated) return;

    console.log('CALENDAR RESCHEDULE UPDATE FAILED: creating replacement event', {
      appointmentId,
      eventId
    });
  }

  const replacementEventId = await createCalendarEvent(
    calendarCollected,
    callerPhone
  );

  if (appointmentId && replacementEventId) {
    await updateAppointmentCalendarEventId(appointmentId, replacementEventId);
  }

  return;
}

  if (currentState === 'cancelled') {
    const appointmentId = collected?.cancel_appointment_id;
    const appointment = await getAppointmentById(appointmentId);
    const eventId = collected?.google_calendar_event_id || appointment?.google_calendar_event_id;

    if (!eventId) {
      console.log('CALENDAR CANCEL SYNC SKIPPED: no saved google event id', { appointmentId });
      return;
    }

    await deleteCalendarEvent(eventId);
  }
}

async function resetSessionToTimeChoice(sessionId, targetState) {
  try {
    const response = await callSupabaseRpc('reset_session_to_time_choice', {
      p_session_id: sessionId,
      p_target_state: targetState
    });

    console.log('SESSION RESET TO TIME CHOICE:', response);
    return response;
  } catch (error) {
    console.log('SESSION RESET ERROR:', error.response?.data || error.message);
    return null;
  }
}

async function handleGoogleAvailabilityBlockIfNeeded(response) {
  const currentState = response.current_state;
  const collected = response.collected || {};
  const sessionId = response.session_id;

  if (currentState === 'collect_time') {
    const fullDayBlock = await getGoogleCalendarFullDayBlock(collected);

    if (fullDayBlock.blocked) {
      const resetCollected = removeCollectedKeys(collected, ['day', 'resolved_date', 'time', 'name']);
      await updateCallSessionState(sessionId, 'collect_day', resetCollected);

      return {
        currentState: 'collect_day',
        response: buildFullDayBlockMessage(
          fullDayBlock,
          'Wade is unavailable that day. What other day works?'
        )
      };
    }
  }

  if (currentState === 'reschedule_time') {
    const fullDayBlock = await getGoogleCalendarFullDayBlock(collected);

    if (fullDayBlock.blocked) {
      const resetCollected = removeCollectedKeys(collected, ['day', 'resolved_date', 'time']);
      await updateCallSessionState(sessionId, 'reschedule_day', resetCollected);

      return {
        currentState: 'reschedule_day',
        response: buildFullDayBlockMessage(
          fullDayBlock,
          'Wade is unavailable that day. What other day would you like to move it to?'
        ).replace('What other day works?', 'What other day would you like to move it to?')
      };
    }
  }

  if (currentState !== 'collect_name' && currentState !== 'reschedule_confirm') {
    return null;
  }

  const targetState = currentState === 'collect_name'
    ? 'collect_time'
    : 'reschedule_time';

  const slotBlock = await getGoogleCalendarSlotBlock(collected);

  if (!slotBlock.blocked) return null;

  await resetSessionToTimeChoice(sessionId, targetState);

  return {
    currentState: targetState,
    response: buildTimeRangeBlockMessage(
      slotBlock,
      'Wade is unavailable at that time. What other time works?'
    )
  };
}

function buildCustomerText(currentState, collected) {
  const name = collected?.name || 'there';
  const service = formatServiceForText(collected?.service);

  if (currentState === 'booked') {
    return `Hi ${name}, your ${service} at Wade and Me Barbershop is confirmed. Reply STOP to opt out.`;
  }

  if (currentState === 'cancelled') {
    return `Hi ${name}, your appointment at Wade and Me Barbershop has been cancelled. Reply STOP to opt out.`;
  }

  if (currentState === 'rescheduled') {
    return `Hi ${name}, your ${service} at Wade and Me Barbershop has been rescheduled. Reply STOP to opt out.`;
  }

  return null;
}

function buildOwnerMessageText(collected, callerPhone) {
  const name = collected?.name || 'Unknown caller';
  const body = collected?.message_body || 'No message body captured.';

  return `New message for Wade from ${name}\nCallback: ${callerPhone}\nMessage: ${body}`;
}

app.post('/voice', async (req, res) => {
  const demoConfig = await loadDemoConfig();
  const twiml = gatherTwiml(demoConfig.greeting || buildDemoGreeting(demoConfig));

  res.type('text/xml');
  res.send(twiml);
});

app.post('/voice-repeat', async (req, res) => {
  try {
    const sessionCallerId = getSessionCallerId(req);

    const repeatResponse = await callSupabaseRpc('get_repeat_prompt', {
      p_caller_id: sessionCallerId
    });

    console.log('REPEAT RESPONSE:', repeatResponse);

    const twiml = gatherTwiml(
      repeatResponse.response || 'I did not catch that. Please say that again.'
    );

    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.log('REPEAT ERROR:', error.response?.data || error.message);

    const twiml = gatherTwiml(
      'I did not catch that. Please say that again.'
    );

    res.type('text/xml');
    res.send(twiml);
  }
});

app.post('/gather', async (req, res) => {
  try {
    const transcript = req.body.SpeechResult || '';
    const sessionCallerId = getSessionCallerId(req);
    const callerPhone = getCallerPhone(req);

    console.log('TRANSCRIPT:', transcript);
    console.log('SESSION CALLER ID:', sessionCallerId);
    console.log('CALLER PHONE:', callerPhone);
    console.log('BODY:', req.body);

    if (!transcript.trim()) {
      const repeatResponse = await callSupabaseRpc('get_repeat_prompt', {
        p_caller_id: sessionCallerId
      });

      const twiml = gatherTwiml(
        repeatResponse.response || 'I did not catch that. Please say that again.'
      );

      res.type('text/xml');
      res.send(twiml);
      return;
    }

    const response = await callSupabaseRpc('scheduler_turn', {
      p_transcript: transcript,
      p_caller_id: sessionCallerId
    });

    console.log('SUPABASE RESPONSE:', response);

    const availabilityBlock = await handleGoogleAvailabilityBlockIfNeeded(response);

    if (availabilityBlock) {
      const twiml = gatherTwiml(availabilityBlock.response);

      res.type('text/xml');
      res.send(twiml);
      return;
    }

    const aiResponse = response.response || 'Sorry, something went wrong.';
    const currentState = response.current_state;
    const collected = response.collected || {};

    await syncCalendarAfterSchedulerTurn(currentState, collected, callerPhone);

    if (currentState === 'message_saved') {
      const ownerMessage = buildOwnerMessageText(collected, callerPhone);

      await sendOwnerEmail(
        `New message for Wade from ${collected?.name || 'caller'}`,
        ownerMessage
      );

      await sendSms(
        process.env.WADE_PHONE_NUMBER,
        ownerMessage
      );
    }

    const customerText = buildCustomerText(currentState, collected);

    if (customerText && callerPhone !== 'unknown') {
      await sendSms(callerPhone, customerText);
    }

    const demoConfig = isTerminalState(currentState)
      ? await loadDemoConfig()
      : null;

    const twiml = isTerminalState(currentState)
      ? hangupTwiml(aiResponse, demoConfig)
      : gatherTwiml(aiResponse);

    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.log('ERROR:', error.response?.data || error.message);

    const demoConfig = await loadDemoConfig();
    const twiml = hangupTwiml(
      'Sorry, I had trouble checking the schedule. Please try again.',
      demoConfig
    );

    res.type('text/xml');
    res.send(twiml);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
});
