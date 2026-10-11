/** The memo attached to an upgrade payment (shared by issuer and the app's safety check). */
export const upgradeMemoText = (wallet: string, tier: number) => `rugreplay/upgrade/1 ${JSON.stringify({ w: wallet, t: tier })}`;
