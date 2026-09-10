import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ShowNomadPackForm } from "../nomad-pack/show";
import { ComposeActions } from "./actions";
import { ShowProviderFormCompose } from "./generic/show";
import { ShowComposeNodePool } from "./node-pool";

interface Props {
	composeId: string;
}

export const ShowGeneralCompose = ({ composeId }: Props) => {
	const { data } = api.compose.one.useQuery(
		{ composeId },
		{
			enabled: !!composeId,
		},
	);

	return (
		<>
			<Card className="bg-background">
				<CardHeader>
					<div className="flex flex-row gap-2 justify-between flex-wrap">
						<CardTitle className="text-xl">Deploy Settings</CardTitle>
						<Badge>
							{data?.composeType === "docker-compose"
								? "Compose"
								: data?.composeType === "nomad"
									? "Nomad"
									: data?.composeType === "nomad-pack"
										? "Nomad Pack"
										: "Stack"}
						</Badge>
					</div>

					<CardDescription>
						Create a compose file to deploy your compose
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4 flex-wrap">
					<ComposeActions composeId={composeId} />
				</CardContent>
			</Card>
			{data?.composeType === "nomad-pack" ? (
				<ShowNomadPackForm composeId={composeId} />
			) : (
				<ShowProviderFormCompose composeId={composeId} />
			)}
			{data?.composeType === "nomad" && (
				<ShowComposeNodePool composeId={composeId} />
			)}
		</>
	);
};
