export function escapeXmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value)
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
