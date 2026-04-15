import nodemailer from 'nodemailer'

// ---- Nodemailer transporter (Gmail) ----

const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'elijahandrew1610@gmail.com',
    pass: process.env.SMTP_PASS || '',
  },
})

export async function sendEmail(to: string, subject: string, text: string) {
  const info = await transporter.sendMail({
    from: process.env.SMTP_USER || 'elijahandrew1610@gmail.com',
    to,
    subject,
    text,
  })
  return { messageId: info.messageId }
}

export async function sendBulkEmails(emails: { to: string; subject: string; text: string }[]) {
  const results = await Promise.allSettled(
    emails.map(email => transporter.sendMail({
      from: process.env.SMTP_USER || 'elijahandrew1610@gmail.com',
      to: email.to,
      subject: email.subject,
      text: email.text,
    }))
  )

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return { to: emails[index].to, success: true, messageId: result.value.messageId }
    } else {
      return { to: emails[index].to, success: false, error: result.reason?.message }
    }
  })
}
