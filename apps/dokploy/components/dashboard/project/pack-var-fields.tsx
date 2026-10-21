import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
	displayDefault,
	isEditable,
	isStructured,
	type PackVar,
} from "@/lib/pack-vars";

interface Props {
	variables: PackVar[];
	values: Record<string, string>;
	onChange: (name: string, value: string) => void;
}

/**
 * Renders the editable variables of a Nomad Pack as a form (string/number as an
 * input, bool as a select), with "change me" / "secret" badges. Shared by the
 * single-pack configure step and each pack's section in the stack flow so both
 * render and validate variables identically.
 */
export const PackVarFields = ({ variables, values, onChange }: Props) => {
	const editable = variables.filter(isEditable);
	return (
		<>
			{editable.map((v) => (
				<div key={v.name} className="space-y-1.5">
					<Label className="flex items-center gap-2 text-sm">
						<code className="text-xs">{v.name}</code>
						{v.placeholder && (
							<Badge variant="yellow" className="px-1.5 py-0 text-[10px]">
								change me
							</Badge>
						)}
						{v.sensitive && (
							<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
								secret
							</Badge>
						)}
					</Label>
					{v.kind === "bool" ? (
						<Select
							value={values[v.name] ?? displayDefault(v)}
							onValueChange={(val) => onChange(v.name, val)}
						>
							<SelectTrigger className="w-full sm:w-[200px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="true">true</SelectItem>
								<SelectItem value="false">false</SelectItem>
							</SelectContent>
						</Select>
					) : isStructured(v) ? (
						<Textarea
							className="font-mono text-xs"
							rows={3}
							spellCheck={false}
							placeholder={v.type}
							value={values[v.name] ?? displayDefault(v)}
							onChange={(e) => onChange(v.name, e.target.value)}
						/>
					) : (
						<Input
							type={
								v.sensitive
									? "password"
									: v.kind === "number"
										? "number"
										: "text"
							}
							value={values[v.name] ?? ""}
							onChange={(e) => onChange(v.name, e.target.value)}
						/>
					)}
					{(v.description || isStructured(v)) && (
						<p className="text-muted-foreground text-xs">
							{v.description}
							{isStructured(v) && (
								<span className="opacity-70">
									{v.description ? " " : ""}HCL {v.type}
								</span>
							)}
						</p>
					)}
				</div>
			))}
		</>
	);
};
