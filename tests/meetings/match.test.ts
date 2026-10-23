import { describe, expect, it } from 'vitest';
import { domainOf, inDomains, matchClient, normaliseText, type MatchableClient, type MatchInput } from '../../src/meetings/match.ts';

const SHARMA: MatchableClient = { clientId: 1, name: 'Sharma Interiors', emailDomains: ['sharma.in'], meetingKeywords: ['villa project'] };
const MEHTA: MatchableClient = { clientId: 2, name: 'Mehta Foods', emailDomains: ['mehtafoods.com'], meetingKeywords: ['mft'] };
const CLIENTS = [SHARMA, MEHTA];
const TEAM = ['studio.in'];

const me = { email: 'owner@studio.in', self: true };
const input = (title: string, emails: string[] = [], hasInvite = true, withSelf = true): MatchInput => ({
  title,
  hasInvite,
  attendees: [...(withSelf ? [me] : []), ...emails.map((email) => ({ email, self: false }))],
});

describe('normaliseText', () => {
  it('folds case, compatibility forms and punctuation, and keeps letters and marks', () => {
    expect(normaliseText('  Sharma–Interiors:  REVIEW!! ')).toBe('sharma interiors review');
    expect(normaliseText('ＳＨＡＲＭＡ')).toBe('sharma');
    expect(normaliseText('Café ☕ meet')).toBe('café meet');
    expect(normaliseText('शर्मा जी, नमस्ते')).toBe('शर्मा जी नमस्ते');
  });
});

describe('domains', () => {
  it('reads the domain after the last @, lower-cased', () => {
    expect(domainOf(' Asha@Sharma.IN ')).toBe('sharma.in');
    expect(domainOf('conference-room')).toBeNull();
    expect(domainOf('a@')).toBeNull();
  });
  it('matches equal domains and subdomains only', () => {
    expect(inDomains('sharma.in', ['sharma.in'])).toBe(true);
    expect(inDomains('mail.sharma.in', ['sharma.in'])).toBe(true);
    expect(inDomains('notsharma.in', ['sharma.in'])).toBe(false);
    expect(inDomains('sharma.in.evil.com', ['sharma.in'])).toBe(false);
  });
});

describe('matchClient by title', () => {
  it('matches a client name as whole words', () => {
    expect(matchClient(input('Sharma Interiors — logo review'), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 1, by: 'title' });
  });
  it('matches a keyword', () => {
    expect(matchClient(input('MFT weekly'), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 2, by: 'title' });
    expect(matchClient(input('The Villa-Project kickoff'), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 1, by: 'title' });
  });
  it('does not match a keyword inside a longer word', () => {
    expect(matchClient(input('MFTX planning'), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
    const sharmaji: MatchableClient = { clientId: 3, name: 'Sharma', emailDomains: [], meetingKeywords: [] };
    expect(matchClient(input('Sharmaji call'), [sharmaji], TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('is ambiguous when the title names two clients', () => {
    expect(matchClient(input('Sharma Interiors and Mehta Foods intro'), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'ambiguous' });
  });
  it('keeps the title match when the domain points at the same client', () => {
    expect(matchClient(input('Sharma Interiors review', ['ravi@sharma.in']), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 1, by: 'title' });
  });
  it('is ambiguous when title and domain point at different clients', () => {
    expect(matchClient(input('Sharma Interiors review', ['ravi@mehtafoods.com']), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'ambiguous' });
  });
  it('matches Devanagari titles and keywords', () => {
    const c: MatchableClient = { clientId: 4, name: 'Gupta Traders', emailDomains: [], meetingKeywords: ['गुप्ता जी'] };
    expect(matchClient(input('गुप्ता जी के साथ बैठक'), [c], TEAM)).toEqual({ kind: 'client', clientId: 4, by: 'title' });
    expect(matchClient(input('गुप्ता जीवन'), [c], TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('matches titles with diacritics, in either Unicode form', () => {
    const c: MatchableClient = { clientId: 5, name: 'Café Zoë', emailDomains: [], meetingKeywords: [] };
    expect(matchClient(input('CAFÉ ZOË: menu'), [c], TEAM)).toEqual({ kind: 'client', clientId: 5, by: 'title' });
    expect(matchClient(input('café zoë menu'), [c], TEAM)).toEqual({ kind: 'client', clientId: 5, by: 'title' });
    expect(matchClient(input('Cafe Zoe menu'), [c], TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('ignores inactive clients', () => {
    const inactive = { ...SHARMA, active: false };
    expect(matchClient(input('Sharma Interiors review', ['ravi@sharma.in']), [inactive, MEHTA], TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
});

describe('matchClient by domain', () => {
  it('matches an exact domain', () => {
    expect(matchClient(input('Weekly call', ['ravi@sharma.in']), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 1, by: 'domain' });
  });
  it('matches a subdomain, case-insensitively', () => {
    expect(matchClient(input('Weekly call', ['Ravi@Mail.Sharma.IN']), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 1, by: 'domain' });
  });
  it('is ambiguous when attendees come from two clients', () => {
    expect(matchClient(input('Weekly call', ['ravi@sharma.in', 'om@mehtafoods.com']), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'ambiguous' });
  });
  it('ignores attendees without an @', () => {
    expect(matchClient(input('Weekly call', ['sharma.in']), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('is unassigned when nothing matches', () => {
    expect(matchClient(input('Weekly call', ['someone@elsewhere.com']), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
});

describe('matchClient internal', () => {
  it('is internal when every other attendee is on the team', () => {
    expect(matchClient(input('Team standup', ['asha@studio.in', 'dev@eng.studio.in']), CLIENTS, TEAM)).toEqual({ kind: 'internal' });
  });
  it('reads the team domain list case-insensitively', () => {
    expect(matchClient(input('Team standup', ['asha@STUDIO.in']), CLIENTS, ['Studio.IN'])).toEqual({ kind: 'internal' });
  });
  it('is never internal without an invite', () => {
    expect(matchClient(input('Team standup', ['asha@studio.in'], false), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('is not internal with no attendees, or only the mailbox itself', () => {
    expect(matchClient(input('Team standup', [], true, false), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
    expect(matchClient(input('Team standup', []), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('is not internal when the only other attendee has no email (a room)', () => {
    expect(matchClient(input('Team standup', ['Board room']), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('is not internal when one attendee is outside the team', () => {
    expect(matchClient(input('Team standup', ['asha@studio.in', 'x@elsewhere.com']), CLIENTS, TEAM)).toEqual({ kind: 'unassigned', reason: 'none' });
  });
  it('is not internal when the title names a client', () => {
    expect(matchClient(input('Sharma Interiors prep', ['asha@studio.in']), CLIENTS, TEAM)).toEqual({ kind: 'client', clientId: 1, by: 'title' });
  });
});
