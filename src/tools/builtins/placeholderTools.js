import { Tool, RiskLevel } from '../Tool.js';

/**
 * These tools represent capabilities that need something this backend
 * genuinely cannot provide on its own: a native mobile companion app with
 * OS-level permissions, or a WhatsApp Business / Twilio account. They're
 * registered so the planner/AI can see they're part of the system's design
 * — but calling them throws a clear, specific error rather than simulating
 * success (spec section 37). See docs/MOBILE_COMPANION_CONTRACT.md for the
 * interface a real companion app would implement against this backend.
 *
 * (send_email, create_calendar_event, and search_web graduated out of this
 * file — they're real now, in emailTools.js / calendarTools.js / researchTools.js.)
 */
export function buildPlaceholderTools() {
  return [
    new Tool({
      name: 'send_whatsapp_message',
      description: 'Send a WhatsApp message.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, message: { type: 'string' } },
        required: ['to', 'message'],
      },
      requiredPermissions: ['whatsapp.send'],
      riskLevel: RiskLevel.EXTERNAL,
      status: 'REQUIRES_THIRD_PARTY_SERVICE', // needs WhatsApp Business API + verified number
      execute: async () => {
        throw new Error('send_whatsapp_message requires a WhatsApp Business API account — not configured.');
      },
    }),

    new Tool({
      name: 'make_phone_call',
      description: 'Initiate a phone call and hold a voice conversation.',
      inputSchema: {
        type: 'object',
        properties: { contact: { type: 'string' }, purpose: { type: 'string' } },
        required: ['contact', 'purpose'],
      },
      requiredPermissions: ['calls.initiate'],
      riskLevel: RiskLevel.EXTERNAL,
      status: 'REQUIRES_THIRD_PARTY_SERVICE', // needs Twilio (or similar) account + number
      execute: async () => {
        throw new Error('make_phone_call requires a Twilio account and phone number — not configured.');
      },
    }),
  ];
}
