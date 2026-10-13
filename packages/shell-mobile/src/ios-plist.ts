export const URL_TYPES_KEY = "CFBundleURLTypes";

export function urlTypesXml(appId: string, scheme: string): string {
  return `	<key>${URL_TYPES_KEY}</key>
	<array>
		<dict>
			<key>CFBundleTypeRole</key>
			<string>Editor</string>
			<key>CFBundleURLName</key>
			<string>${appId}</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>${scheme}</string>
			</array>
		</dict>
	</array>
`;
}

export function withUrlScheme(plist: string, appId: string, scheme: string): string {
  const stripped = plist.replace(
    new RegExp(`\\t<key>${URL_TYPES_KEY}</key>\\n\\t<array>[\\s\\S]*?\\n\\t</array>\\n`),
    "",
  );
  const closing = stripped.lastIndexOf("</dict>");
  if (closing === -1) throw new Error("Info.plist has no top-level dict");
  return `${stripped.slice(0, closing)}${urlTypesXml(appId, scheme)}${stripped.slice(closing)}`;
}
