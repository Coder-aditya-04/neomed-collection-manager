import { describe, it, expect } from 'vitest';
import { toWhatsAppNumber, whatsAppLink } from '../src/features/registers/Registers.jsx';

describe('WhatsApp number normalisation', () => {
  it('accepts the ways an Indian mobile actually gets typed', () => {
    expect(toWhatsAppNumber('9876543210')).toBe('919876543210');
    expect(toWhatsAppNumber('98765 43210')).toBe('919876543210');
    expect(toWhatsAppNumber('+91 98765 43210')).toBe('919876543210');
    expect(toWhatsAppNumber('09876543210')).toBe('919876543210');
    expect(toWhatsAppNumber('91-98765-43210')).toBe('919876543210');
    expect(toWhatsAppNumber('(0) 98765-43210')).toBe('919876543210');
  });

  it('refuses anything too short to be a number', () => {
    expect(toWhatsAppNumber('')).toBeNull();
    expect(toWhatsAppNumber(null)).toBeNull();
    expect(toWhatsAppNumber('12345')).toBeNull();
    expect(toWhatsAppNumber('not a phone')).toBeNull();
  });
});

describe('WhatsApp draft message', () => {
  const party = { display_name: 'GODAVARI NURSING HOME', current_outstanding: 8972000 };

  it('names the party and the balance in Indian format', () => {
    const url = whatsAppLink('9876543210', party);
    const text = decodeURIComponent(new URL(url).searchParams.get('text'));
    expect(url.startsWith('https://wa.me/919876543210')).toBe(true);
    expect(text).toContain('GODAVARI NURSING HOME');
    expect(text).toContain('₹89.72 L');
  });

  it('greets the contact person when one is recorded', () => {
    const url = whatsAppLink('9876543210', { ...party, contact_person: 'Dr Kulkarni' });
    const text = decodeURIComponent(new URL(url).searchParams.get('text'));
    expect(text).toContain('Dr Kulkarni');
  });

  it('produces no link at all without a usable number', () => {
    expect(whatsAppLink('', party)).toBeNull();
    expect(whatsAppLink('123', party)).toBeNull();
  });
});
