/**
 * B2-2 — MailSender port with the captured, non-delivering dev/test
 * implementation (docs/26 §14 D2). No production email is sent anywhere in
 * this slice; log representations never carry message bodies or addresses.
 */
import {
  CaptureMailSender,
  mailLogLine,
  type MailMessage,
} from '../src/modules/identity/mail/mail-sender';

const MESSAGE: MailMessage = {
  to: 'person@example.test',
  template: 'account_exists_notice',
  subject: 'Your Himma account',
  body: 'You already have a Himma account. Sign in with your existing method. Code-like secret: 123456',
};

describe('CaptureMailSender', () => {
  it('captures the full intended message without delivering anything', async () => {
    const sender = new CaptureMailSender();
    await sender.send(MESSAGE);
    expect(sender.captured).toHaveLength(1);
    expect(sender.captured[0]).toMatchObject({
      to: MESSAGE.to,
      template: MESSAGE.template,
      subject: MESSAGE.subject,
      body: MESSAGE.body,
    });
  });

  it('records messages in order and independently per instance', async () => {
    const a = new CaptureMailSender();
    const b = new CaptureMailSender();
    await a.send(MESSAGE);
    await a.send({ ...MESSAGE, template: 'second' });
    expect(a.captured.map((m) => m.template)).toEqual(['account_exists_notice', 'second']);
    expect(b.captured).toHaveLength(0);
  });
});

describe('mailLogLine (the only sanctioned log representation of a mail)', () => {
  it('carries the template but neither the body, the subject line, nor the raw address', () => {
    const line = mailLogLine(MESSAGE);
    expect(line).toContain('account_exists_notice');
    expect(line).not.toContain('123456');
    expect(line).not.toContain(MESSAGE.body.slice(0, 20));
    expect(line).not.toContain('person@example.test');
    expect(line).not.toContain(MESSAGE.subject);
  });

  it('is deterministic for one recipient and distinct across recipients', () => {
    expect(mailLogLine(MESSAGE)).toBe(mailLogLine(MESSAGE));
    expect(mailLogLine(MESSAGE)).not.toBe(mailLogLine({ ...MESSAGE, to: 'other@example.test' }));
  });
});
