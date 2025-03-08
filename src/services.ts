import { Context } from 'hono';

export async function sendSms(c: Context<{ Bindings: Env }>, phoneNumber: number, teamId: string) {
	const response = await fetch('https://api.httpsms.com/v1/messages/send', {
		method: 'POST',
		headers: {
			'x-api-Key': c.env.HTTPSMS_APIKEY,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			content: `${teamId} is your OTP\n- Team CodeX`,
			encrypted: false,
			from: `+91${c.env.PHONE_NUMBER}`,
			to: `+91${phoneNumber}`,
		}),
	});

	const data: any = await response.json();

	if (data?.status != 'success') {
		throw new Error('SMSERROR');
	}
}
