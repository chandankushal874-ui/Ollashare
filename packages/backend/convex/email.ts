"use node";

import { v } from "convex/values";
import nodemailer from "nodemailer";
import { internalAction } from "./_generated/server";

/**
 * SMTP sender (Node action). Auth providers dispatch here and fail closed when SMTP is unavailable.
 * Local inbox: point SMTP_HOST/SMTP_PORT at Mailpit (default :1025).
 */
export const sendEmail = internalAction({
	args: { to: v.string(), subject: v.string(), text: v.string() },
	handler: async (_ctx, { to, subject, text }) => {
		const host = process.env.SMTP_HOST;
		if (!host) throw new Error("Authentication email is not configured");
		const from = process.env.SMTP_FROM;
		if (process.env.NODE_ENV === "production" && !from)
			throw new Error("Authentication email is not configured");
		const transport = nodemailer.createTransport({
			host,
			port: Number(process.env.SMTP_PORT ?? "1025"),
			secure: false,
			requireTLS:
				process.env.NODE_ENV === "production" &&
				!["localhost", "127.0.0.1"].includes(host),
			disableFileAccess: true,
			disableUrlAccess: true,
			connectionTimeout: 10000,
			greetingTimeout: 10000,
			socketTimeout: 10000,
			...(process.env.SMTP_USER
				? {
						auth: {
							user: process.env.SMTP_USER,
							pass: process.env.SMTP_PASS ?? "",
						},
					}
				: {}),
		});
		try {
			const result = await transport.sendMail({
				from: from ?? "auth@myos.local",
				to,
				subject,
				text,
			});
			if (!result.accepted?.length || result.rejected?.length)
				throw new Error("Delivery rejected");
		} catch {
			throw new Error("Unable to send authentication email");
		} finally {
			transport.close();
		}
	},
});
