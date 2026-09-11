import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { notifications } from "../../db/schema";
import {
	sendCustomNotification,
	sendDiscordNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendPushoverNotification,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "./utils";

export interface ClusterAlertPayload {
	/** Maps onto the autoscaler event type. */
	EventType: "scale_up" | "scale_down" | "error";
	Message: string;
	Detail?: string;
	Timestamp: string;
	/** Autoscaling group / node pool the event belongs to, when known. */
	GroupName?: string;
}

const META: Record<
	ClusterAlertPayload["EventType"],
	{ title: string; emoji: string; color: number; slackColor: string }
> = {
	scale_up: {
		title: "Cluster scaled up",
		emoji: "⬆️",
		color: 0x2ecc71,
		slackColor: "#2ECC71",
	},
	scale_down: {
		title: "Cluster scaled down",
		emoji: "⬇️",
		color: 0x3498db,
		slackColor: "#3498DB",
	},
	error: {
		title: "Cluster autoscaler error",
		emoji: "⚠️",
		color: 0xff0000,
		slackColor: "#FF0000",
	},
};

/**
 * Fan a cluster/autoscaler activity event out to every notification channel that
 * has clusterAlert enabled for the org. Mirrors the server-threshold monitoring
 * alert set (Discord/Telegram/Slack/Mattermost/custom/Lark/Pushover/Teams).
 * Best-effort: a failing channel is logged, never thrown, so one bad webhook
 * can't block the autoscaler loop.
 */
export const sendClusterAlertNotifications = async (
	organizationId: string,
	payload: ClusterAlertPayload,
) => {
	const date = new Date(payload.Timestamp);
	const meta = META[payload.EventType];
	const group = payload.GroupName ? ` (${payload.GroupName})` : "";
	const title = `${meta.emoji} ${meta.title}${group}`;

	const notificationList = await db.query.notifications.findMany({
		where: and(
			eq(notifications.clusterAlert, true),
			eq(notifications.organizationId, organizationId),
		),
		with: {
			discord: true,
			telegram: true,
			slack: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});

	for (const notification of notificationList) {
		const {
			discord,
			telegram,
			slack,
			mattermost,
			custom,
			lark,
			pushover,
			teams,
		} = notification;

		try {
			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();
				await sendDiscordNotification(discord, {
					title,
					color: meta.color,
					fields: [
						{
							name: decorate("`📜`", "Message"),
							value: payload.Message,
						},
						...(payload.Detail
							? [
									{
										name: decorate("`🔎`", "Detail"),
										value: `\`\`\`${payload.Detail}\`\`\``,
									},
								]
							: []),
						{
							name: decorate("`⌚`", "Time"),
							value: date.toLocaleString(),
							inline: true,
						},
					],
					timestamp: date.toISOString(),
					footer: { text: "Nomploy Cluster Alert" },
				});
			}

			if (telegram) {
				await sendTelegramNotification(
					telegram,
					`<b>${title}</b>\n<b>Message:</b> ${payload.Message}${
						payload.Detail ? `\n<b>Detail:</b> ${payload.Detail}` : ""
					}\n<b>Time:</b> ${date.toLocaleString()}`,
				);
			}

			if (slack) {
				await sendSlackNotification(slack, {
					channel: slack.channel,
					attachments: [
						{
							color: meta.slackColor,
							pretext: `*${title}*`,
							fields: [
								{ title: "Message", value: payload.Message },
								...(payload.Detail
									? [{ title: "Detail", value: payload.Detail }]
									: []),
								{ title: "Time", value: date.toLocaleString(), short: true },
							],
						},
					],
				});
			}

			if (mattermost) {
				await sendMattermostNotification(mattermost, {
					text: `**${title}**\n\n**Message:** ${payload.Message}${
						payload.Detail ? `\n**Detail:** ${payload.Detail}` : ""
					}\n**Time:** ${date.toLocaleString()}`,
					channel: mattermost.channel,
					username: mattermost.username || "Nomploy",
				});
			}

			if (custom) {
				await sendCustomNotification(custom, {
					title,
					message: payload.Message,
					detail: payload.Detail ?? "",
					eventType: payload.EventType,
					groupName: payload.GroupName ?? "",
					timestamp: date.toISOString(),
					date: date.toLocaleString(),
					status: "alert",
					alertType: "cluster-alert",
				});
			}

			if (lark) {
				await sendLarkNotification(lark, {
					msg_type: "interactive",
					card: {
						schema: "2.0",
						config: { update_multi: true },
						header: {
							title: { tag: "plain_text", content: title },
							template: payload.EventType === "error" ? "red" : "blue",
							padding: "12px 12px 12px 12px",
						},
						body: {
							direction: "vertical",
							padding: "12px 12px 12px 12px",
							elements: [
								{
									tag: "markdown",
									content: `**Message:**\n${payload.Message}${
										payload.Detail ? `\n\n**Detail:**\n${payload.Detail}` : ""
									}\n\n**Time:**\n${date.toLocaleString()}`,
									text_align: "left",
									text_size: "normal_v2",
								},
							],
						},
					},
				});
			}

			if (pushover) {
				await sendPushoverNotification(
					pushover,
					title,
					`${payload.Message}${
						payload.Detail ? `\nDetail: ${payload.Detail}` : ""
					}\nTime: ${date.toLocaleString()}`,
				);
			}

			if (teams) {
				await sendTeamsNotification(teams, {
					title,
					facts: [
						{ name: "Message", value: payload.Message },
						...(payload.Detail
							? [{ name: "Detail", value: payload.Detail }]
							: []),
						{ name: "Time", value: date.toLocaleString() },
					],
				});
			}
		} catch (error) {
			console.log(error);
		}
	}
};
