// ─── LEGAL PAGES ──────────────────────────────────────────────────────────────
// Terms, privacy, refunds, disclaimer, responsible gambling and data credits,
// served as plain pages at stable paths (/terms, /privacy, ...). The operator's
// details come from settings so nothing personal sits in the repo:
//   LEGAL_ENTITY   who runs it (default "Line Reaper"), e.g. "Line Reaper LLC"
//   LEGAL_EMAIL    the support / legal contact address
//   LEGAL_STATE    the US state whose law governs the terms, e.g. "Ohio"
//   LEGAL_ADDRESS  optional postal address for notices
// TERMS_VERSION is what sign-up records; bump it when the terms change so the
// app asks people to accept again.

const TERMS_VERSION = '2026-10-12';
const EFFECTIVE = 'October 12, 2026';
const REFUND_HOURS = 72;
const MIN_AGE = 21;

const { escHtml: esc } = require('./mathutil');

function configFromEnv(env = process.env) {
  return {
    operator: String(env.LEGAL_ENTITY || '').trim() || 'Line Reaper',
    email: String(env.LEGAL_EMAIL || '').trim(),
    state: String(env.LEGAL_STATE || '').trim(),
    address: String(env.LEGAL_ADDRESS || '').trim(),
  };
}

// "email us at x" when an address is set, or a pointer to the contact section
const mail = c => (c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'the contact address on our <a href="/legal#contact">legal page</a>');
const law = c => (c.state ? `the State of ${esc(c.state)}` : 'the state in which the operator is based');

const PAGES = {};

// ── Terms of Service ──
PAGES.terms = {
  title: 'Terms of Service',
  lead: 'The agreement between you and Line Reaper. Please read it, in particular the sections on betting risk, the subscription, the limits on our liability, and arbitration.',
  body: c => `
<h2 id="agreement">1. Agreeing to these terms</h2>
<p>These Terms of Service ("Terms") are a contract between you and ${esc(c.operator)} ("Line Reaper", "we", "us"). They cover the Line Reaper website, web app, alerts, and any other service we offer (together, the "Service").</p>
<p>You accept these Terms when you tick the box to agree, create an account, enter the app, or pay for a subscription. Our <a href="/privacy">Privacy Policy</a>, <a href="/refunds">Refund and Cancellation Policy</a>, <a href="/disclaimer">Betting and Results Disclaimer</a> and <a href="/responsible-gambling">Responsible Gambling</a> page are part of these Terms. If you do not agree, do not use the Service.</p>

<h2 id="eligibility">2. Who can use Line Reaper</h2>
<p>To use the Service you must:</p>
<ul>
<li>be at least ${MIN_AGE} years old, and of legal age to bet in the place where you are;</li>
<li>be located in the United States, in a state where using sports betting, daily fantasy, or prediction market information is lawful for you;</li>
<li>not be barred from using the Service under any law, and not have had a Line Reaper account closed by us for breaking these Terms; and</li>
<li>not be on any gambling self-exclusion list. If you have chosen to exclude yourself from gambling, please do not use the Service.</li>
</ul>
<p>You are responsible for knowing and following the laws that apply to you and the rules of any sportsbook, exchange, prediction market or fantasy operator you use. We may limit or refuse the Service in any place at any time.</p>

<h2 id="what-it-is">3. What Line Reaper is, and what it is not</h2>
<p>Line Reaper is an information and analytics service. It collects publicly available odds, prices and market data, runs models on them, and shows the results, including alerts, ratings, arbitrage and expected-value estimates, and a record of how past alerts turned out.</p>
<p>Line Reaper is <strong>not</strong> a sportsbook, casino, betting exchange, prediction market, daily fantasy operator, broker, futures commission merchant, or bank. We do not accept bets or wagers, hold your money, place orders or trades, or connect to any account you hold elsewhere. Every bet or trade you make is your own decision, made on a platform you choose.</p>
<p>Our content is general and impersonal. Every subscriber at the same plan level gets the same alerts, and unit sizes are shown the same way to everyone. Nothing we publish is tailored to your finances, and nothing is directed at or managed for any person's account. Line Reaper is not registered with the Commodity Futures Trading Commission, the National Futures Association, the Securities and Exchange Commission, or any state as an adviser of any kind. Nothing in the Service is financial, investment, legal, tax or betting advice, or a recommendation that any particular person place any particular bet or trade. See the <a href="/disclaimer">Disclaimer</a>.</p>

<h2 id="risk">4. Betting risk and no guarantees</h2>
<p>Betting and trading on event outcomes is risky, and you can lose all of the money you stake. Odds and prices move quickly, platforms limit or void bets, fees change, and data from third parties can be late, wrong or missing. Arbitrage and "+EV" figures are estimates and can fail. Results of past alerts do not predict future results.</p>
<p>Always check the price, the market rules and the terms at the platform before you place anything. Only bet what you can afford to lose. You alone are responsible for your bets, your trades, and their results, including any tax due.</p>

<h2 id="accounts">5. Your account</h2>
<ul>
<li>Give a real email address you control and keep your password private. You are responsible for activity under your account.</li>
<li>An account is for one person. You may not share, sell, rent or transfer it, or let others use it.</li>
<li>Tell us at once if you believe your account has been used without your permission.</li>
<li>You can delete your account at any time from the app, or by emailing ${mail(c)}.</li>
</ul>

<h2 id="subscriptions">6. Subscriptions, billing and automatic renewal</h2>
<p>Some features need a paid subscription ("Pro"). Payments are processed by our payment provider, Stripe. We never see or store your full card number.</p>
<ul>
<li><strong>Automatic renewal.</strong> Pro is billed in advance and <strong>renews automatically</strong> at the end of each billing period (monthly unless the checkout page says otherwise) at the price shown at checkout, plus any applicable tax, until you cancel.</li>
<li><strong>Cancelling.</strong> You can cancel at any time from <em>Billing</em> in the app (the Stripe customer portal), with no need to call or email anyone. Cancelling stops future charges; you keep Pro until the end of the period you have already paid for.</li>
<li><strong>Free trials and introductory prices.</strong> If we offer a trial or an introductory price, the checkout page will show how long it lasts and what you will be charged after it. A trial turns into a paid subscription unless you cancel before it ends.</li>
<li><strong>Price changes.</strong> We will give you at least 30 days' notice by email or in the app before a price change affects you. The new price applies from your next renewal after the notice period, and you can cancel before then.</li>
<li><strong>Failed payments.</strong> If a renewal payment fails, Stripe may retry it. Pro may stop if the payment is not made.</li>
<li><strong>Refunds.</strong> Refunds follow our <a href="/refunds">Refund and Cancellation Policy</a>.</li>
<li><strong>Chargebacks.</strong> If something is wrong with a charge, please contact us first; we can usually fix it faster than a bank dispute. We may suspend an account while a chargeback is open.</li>
</ul>

<h2 id="use">7. How you may use the Service</h2>
<p>While you follow these Terms, we give you a personal, limited, non-exclusive, non-transferable and revocable licence to use the Service for your own non-commercial purposes. You agree not to:</p>
<ul>
<li>copy, resell, republish, broadcast or redistribute our alerts, picks, ratings, trader grades, data or other content, including posting them in public or paid groups, channels or "tout" services, without our written permission;</li>
<li>scrape, crawl or bulk-download the Service, or access it with bots or scripts other than through features we provide;</li>
<li>get around the paywall, usage limits or security, or share your login;</li>
<li>reverse engineer, decompile or copy the Service or its models, except where the law allows it despite this restriction;</li>
<li>interfere with or overload the Service, or try to get into accounts or systems that are not yours;</li>
<li>use the Service for anything unlawful, including betting where it is not legal for you, or to harass or harm anyone; or</li>
<li>misrepresent your age, location or identity.</li>
</ul>

<h2 id="ip">8. Our content and third-party names</h2>
<p>The Service, its software, models, design, text and the "Line Reaper" name and logo belong to us or our licensors and are protected by law. Apart from the licence in section 7, these Terms give you no rights in them.</p>
<p>Names and logos of sportsbooks, exchanges, prediction markets, fantasy operators, leagues, teams, players and game publishers belong to their owners and are used only to identify them. Line Reaper is not affiliated with, endorsed by, or sponsored by any of them. Market data is credited on our <a href="/data-sources">data sources</a> page.</p>
<p>If you send us ideas or feedback, we may use them without any obligation to you.</p>

<h2 id="third-parties">9. Other websites and platforms</h2>
<p>The Service may link to or show prices from other platforms. We do not control them and are not responsible for their content, availability, prices, rules, or how they treat you or your money. Your dealings with them are between you and them.</p>

<h2 id="availability">10. Changes to the Service</h2>
<p>We are always improving Line Reaper, so features, markets, sports, data sources and coverage change. Data feeds can stop without notice. We may add, change, pause or remove features, and we do not promise any particular feature, market or level of coverage will stay available.</p>

<h2 id="warranty">11. No warranties</h2>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE". TO THE FULLEST EXTENT THE LAW ALLOWS, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY AND AVAILABILITY. WE DO NOT WARRANT THAT THE SERVICE OR ITS DATA WILL BE ACCURATE, COMPLETE, TIMELY, UNINTERRUPTED OR ERROR-FREE, OR THAT USING IT WILL MAKE YOU MONEY.</p>

<h2 id="liability">12. Limits on our liability</h2>
<p>TO THE FULLEST EXTENT THE LAW ALLOWS:</p>
<ul>
<li>WE ARE NOT LIABLE FOR ANY BETTING, TRADING OR INVESTMENT LOSSES, LOST PROFITS OR WINNINGS, LOST DATA, OR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, HOWEVER CAUSED, EVEN IF WE WERE TOLD THEY WERE POSSIBLE; AND</li>
<li>OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICE IS LIMITED TO THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE THREE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, AND (B) FIFTY US DOLLARS (US$50).</li>
</ul>
<p>Some places do not allow some of these limits. Where that is so, they apply only as far as the law allows.</p>

<h2 id="indemnity">13. Your responsibility to us</h2>
<p>You agree to defend and compensate us, and our owners, staff and contractors, for claims, losses and costs (including reasonable legal fees) that arise from your breach of these Terms, your misuse of the Service, or your breaking any law or anyone else's rights.</p>

<h2 id="disputes">14. Disputes, arbitration and class action waiver</h2>
<p><strong>Please read this section carefully. It affects how disputes are resolved.</strong></p>
<p><strong>Talk to us first.</strong> Before starting any claim, send us a written description of the problem and what you want at ${mail(c)}. We will try to resolve it within 30 days.</p>
<p><strong>Binding arbitration.</strong> If we cannot resolve it, you and we agree that any dispute arising out of or relating to these Terms or the Service will be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, rather than in court. The Federal Arbitration Act governs this section. The arbitration may be held by video or phone, or in the county where you live. Either party may instead bring an individual claim in small claims court if it qualifies.</p>
<p><strong>No class actions.</strong> Claims may be brought only individually, not as a plaintiff or class member in any class, collective or representative action, and the arbitrator may not combine claims of more than one person.</p>
<p><strong>Opting out.</strong> You can opt out of this arbitration agreement by emailing ${mail(c)} within 30 days of first accepting these Terms, with your account email and a statement that you opt out of arbitration.</p>
<p><strong>Exceptions.</strong> Either party may seek an injunction in court to stop infringement or misuse of intellectual property or unauthorized access to the Service.</p>
<p>If the class action waiver is found unenforceable for a claim, that claim will go to court, not arbitration. If any other part of this section is found unenforceable, the rest still applies.</p>

<h2 id="law">15. Governing law</h2>
<p>These Terms are governed by the laws of ${law(c)} and the federal laws of the United States, without regard to conflict-of-law rules. Subject to section 14, the state and federal courts located in ${c.state ? esc(c.state) : 'that state'} have exclusive jurisdiction, and you and we consent to them.</p>

<h2 id="termination">16. Ending the agreement</h2>
<p>You can stop using the Service and delete your account at any time. We may suspend or close your account, or stop providing the Service, if you break these Terms, if we are required to by law or by a platform or payment provider, or if we stop offering the Service. If we close your paid account without cause, we will refund the unused part of your current billing period. Sections 4, 8, 11 to 15 and 17 survive the end of this agreement.</p>

<h2 id="changes">17. Changes to these terms</h2>
<p>We may update these Terms. If a change is material, we will give notice in the app or by email at least 14 days before it takes effect, and the app may ask you to accept the new version. If you do not agree, stop using the Service and cancel before the change takes effect. Using the Service after that date means you accept the updated Terms.</p>

<h2 id="general">18. General</h2>
<p>These Terms are the whole agreement between you and us about the Service. If a part is found unenforceable, the rest still applies. Our not enforcing a part is not a waiver. You may not transfer these Terms; we may transfer them to a buyer of the Service or our business. Neither of us is responsible for delays caused by events beyond reasonable control. Notices to you may be sent by email or in the app; notices to us go to ${mail(c)}${c.address ? ` or ${esc(c.address)}` : ''}.</p>
`,
};

// ── Privacy Policy ──
PAGES.privacy = {
  title: 'Privacy Policy',
  lead: 'What we collect, why, who we share it with, and the choices you have. Short version: we collect very little, we never sell it, and there are no ads or ad trackers.',
  body: c => `
<h2 id="who">1. Who we are</h2>
<p>${esc(c.operator)} ("Line Reaper", "we", "us") runs the Line Reaper website and app. Contact us about privacy at ${mail(c)}.</p>

<h2 id="collect">2. What we collect</h2>
<table>
<tr><th>What</th><th>When</th><th>Why</th></tr>
<tr><td>Email address and a hashed password</td><td>When you create an account</td><td>To log you in, run your account, and send account and billing messages</td></tr>
<tr><td>Agreement record (which Terms version you accepted, when, the IP address you accepted from, and that you confirmed your age)</td><td>When you sign up</td><td>To show you agreed to the Terms</td></tr>
<tr><td>Subscription details (Stripe customer ID, plan, status, renewal date)</td><td>When you subscribe</td><td>To give you the features you pay for</td></tr>
<tr><td>Technical data (IP address, browser type, pages and API addresses requested, times, errors)</td><td>Whenever you use the Service</td><td>To run, secure and fix the Service and to stop abuse</td></tr>
<tr><td>Messages you send us</td><td>When you contact us</td><td>To answer you</td></tr>
</table>
<p>We do <strong>not</strong> collect your card details (Stripe handles payment), your sportsbook or exchange logins, your bets on other platforms, your location beyond what an IP address shows, or any government ID.</p>
<p><strong>Stored on your device only.</strong> The app saves some settings in your browser's local storage: your login token, your layout, tool inputs, your unit size, and any bets you log in the bet tracker. These stay on your device and are not sent to us, except the login token, which proves who you are when the app talks to our server. Clearing your browser data removes them.</p>

<h2 id="cookies">3. Cookies and tracking</h2>
<p>We do not use advertising cookies, cross-site trackers, analytics pixels or session-recording tools. The app uses browser storage only for the settings above. Our pages load fonts from Google Fonts, which means Google receives your IP address when your browser fetches them. Because we do no cross-site tracking, there is nothing to opt out of; we treat Global Privacy Control and Do Not Track signals as a request not to sell or share, which we never do anyway.</p>

<h2 id="share">4. Who we share it with</h2>
<p>We share personal information only with service providers who process it for us under contract, and only as needed:</p>
<ul>
<li><strong>Stripe</strong>, for payments and subscription management (<a href="https://stripe.com/privacy" rel="noopener">Stripe's privacy policy</a>);</li>
<li><strong>Railway</strong>, which hosts our servers and database in the United States;</li>
<li><strong>Google Fonts</strong>, as described above; and</li>
<li>an email delivery provider, if and when we send account emails.</li>
</ul>
<p>We may also disclose information if the law requires it, to protect our rights or anyone's safety, or as part of a sale or merger of our business (in which case this policy keeps applying to your information).</p>
<p><strong>We do not sell your personal information, share it for cross-context behavioral advertising, or use it for targeted advertising.</strong></p>

<h2 id="public-data">5. Public market data we display</h2>
<p>Parts of Line Reaper, such as Sharp Tail, analyse public trading activity on prediction markets, including public blockchain wallet addresses and the pseudonymous display names that appear with them. We show this information as it appears publicly, and our grades and labels (such as "sharp") are opinions produced by our models, not statements of fact about any person. If you control a wallet or name we show and want its address and name taken out of what Line Reaper shows, email ${mail(c)} from an address that shows it is yours, or sign a message with the wallet, and we will remove them within 30 days.</p>

<h2 id="keep">6. How long we keep it</h2>
<ul>
<li>Account information: until you delete your account.</li>
<li>Billing records: Stripe keeps payment records as financial and tax law requires.</li>
<li>Server logs: kept by our host for a limited period, usually days to a few weeks.</li>
<li>Backups: deleted data can remain in backups for up to 35 days before it is overwritten.</li>
</ul>

<h2 id="rights">7. Your choices and rights</h2>
<p>Wherever you live in the US, you can ask us to:</p>
<ul>
<li>tell you what personal information we hold about you and give you a copy;</li>
<li>correct it; or</li>
<li>delete it. You can delete your account yourself in the app (log in and choose <em>Delete account</em> at the bottom of the app), or email us.</li>
</ul>
<p>Email ${mail(c)} from the address on your account. We may need to confirm it is you. We answer within 45 days, and we will not treat you differently for using these rights. Residents of California, Colorado, Connecticut, Virginia, Utah, Texas, Oregon and other states with privacy laws have these rights by law; we give them to everyone. You can use an authorized agent if your state allows it. If we turn down a request, you can appeal by replying to our answer.</p>

<h2 id="security">8. Security</h2>
<p>Passwords are stored only as salted scrypt hashes. The Service runs over HTTPS. Payments are handled by Stripe, which is PCI-DSS certified. No system is perfectly secure, so use a password you do not use anywhere else. If a breach affects your information, we will tell you as the law requires.</p>

<h2 id="age">9. Age</h2>
<p>The Service is only for people aged ${MIN_AGE} and over. We do not knowingly collect information from anyone under ${MIN_AGE}. If you believe someone under ${MIN_AGE} has an account, tell us and we will delete it.</p>

<h2 id="where">10. Where your information is kept</h2>
<p>The Service is run from the United States, and your information is stored and processed there.</p>

<h2 id="email">11. Emails</h2>
<p>We send account and billing emails that you need to use the Service. We will only send marketing emails if you agree, and every marketing email will have a one-click unsubscribe.</p>

<h2 id="changes">12. Changes</h2>
<p>If we change this policy in a material way, we will tell you in the app or by email before the change takes effect. The date at the top shows when it last changed.</p>
`,
};

// ── Refunds ──
PAGES.refunds = {
  title: 'Refund and Cancellation Policy',
  lead: 'How to cancel, when you can get your money back, and how to ask.',
  body: c => `
<h2 id="cancel">Cancel any time</h2>
<p>Pro renews automatically until you cancel. You can cancel any time, in a few clicks, from <em>Billing</em> in the app (this opens the secure Stripe portal). You do not have to call or email anyone. When you cancel:</p>
<ul>
<li>you will not be charged again;</li>
<li>you keep Pro until the end of the period you already paid for; and</li>
<li>your account becomes a free account after that. You can delete it at any time.</li>
</ul>

<h2 id="first-payment">First-payment refund</h2>
<p>If you are new to Pro and it is not for you, email us within <strong>${REFUND_HOURS} hours</strong> of your <strong>first</strong> Pro payment and we will refund that payment in full and end your Pro access. This applies once per person and per payment method.</p>

<h2 id="other">Other refunds</h2>
<p>Apart from the first-payment refund, payments are not refundable, and we do not give refunds or credits for part of a billing period, for time you did not use, or because of the results of any bet or trade. Picks and alerts win and lose; a losing result is not a reason for a refund. We will always refund:</p>
<ul>
<li><strong>Billing mistakes</strong>, such as a duplicate charge or a charge after you cancelled;</li>
<li><strong>Long outages</strong>: if Pro is unavailable to you for more than 72 hours in a row because of a problem on our side, you can ask for a refund or credit for the days affected; and</li>
<li><strong>Accounts we close without cause</strong>: the unused part of your current period.</li>
</ul>
<p>Nothing here takes away any refund right you have under the law where you live.</p>

<h2 id="how">How to ask</h2>
<p>Email ${mail(c)} from the address on your account, with the date and amount of the charge. We reply within 3 business days. Approved refunds go back to the original payment method through Stripe and usually show up within 5 to 10 business days.</p>

<h2 id="disputes">Card disputes</h2>
<p>Please contact us before disputing a charge with your bank; it is almost always faster. An account may be paused while a dispute is open.</p>

<h2 id="price">Price changes</h2>
<p>We will tell you at least 30 days before a price change reaches your subscription, so you can cancel first if you want to.</p>
`,
};

// ── Disclaimer ──
PAGES.disclaimer = {
  title: 'Betting and Results Disclaimer',
  lead: 'What our numbers mean and what they do not. Please read this before acting on anything in Line Reaper.',
  body: c => `
<h2 id="info">Information only</h2>
<p>Line Reaper provides sports, esports and prediction market information and analysis for entertainment and educational purposes. Nothing in the Service is financial, investment, legal, tax or betting advice, or a recommendation that you place any particular bet or trade. You make your own decisions and you are responsible for them.</p>

<h2 id="not-operator">We are not a betting operator</h2>
<p>Line Reaper does not take bets, run markets, hold funds, or place orders for anyone. We are not affiliated with, endorsed by, or paid by any sportsbook, exchange, prediction market, daily fantasy operator, league, team or game publisher, and we do not earn commission when you use them.</p>

<h2 id="impersonal">Same alerts for everyone</h2>
<p>Every subscriber sees the same alerts, prices and unit sizes. They are not tailored to your bankroll, goals or circumstances, and we do not direct, manage or trade any account. A "unit" is a generic measure of size; what a unit is worth to you is your choice. Line Reaper is not registered with the CFTC, NFA or SEC.</p>

<h2 id="risk">Risk</h2>
<p>Betting and trading on event outcomes involves substantial risk. You can lose all of the money you stake, and no model, tracker or strategy removes that risk. Only bet money you can afford to lose. If gambling stops being fun, please see our <a href="/responsible-gambling">Responsible Gambling</a> page.</p>

<h2 id="results">Our results and track record</h2>
<ul>
<li><strong>Our own record.</strong> The record on our welcome screen is the operator's own betting history, tracked on Pikkit and shown in units. It is one bettor's results over a limited period, it is <strong>not typical</strong>, and it does not mean you will get similar results.</li>
<li><strong>Alert records.</strong> Alerts are graded at the price shown when the alert went out. You may not get that price: prices move, platforms limit or reject bets, and fees and slippage apply. Your results will differ.</li>
<li><strong>Past results do not guarantee future results.</strong> Edges shrink, markets change, and models are wrong.</li>
</ul>

<h2 id="models">Models, EV and arbitrage</h2>
<p>Probabilities, fair odds, expected value (EV), closing-line value, ratings and trader grades are estimates from statistical models and can be wrong. "Arbitrage" figures assume every leg is filled at the shown price; in practice legs can be limited, voided, re-priced or settled differently by each platform, which can turn a sure-looking profit into a loss. Check every price and every market's rules yourself before acting.</p>

<h2 id="data">Data accuracy</h2>
<p>Odds, lines, prices, stats and results come from third parties and public sources. They can be delayed, incomplete or wrong, and feeds can stop without warning. We do not guarantee the accuracy, completeness or timeliness of any data.</p>

<h2 id="people">Traders and wallets</h2>
<p>Sharp Tail analyses public, pseudonymous trading activity. Labels such as "sharp" and letter grades are our model's opinion about past trading results, not statements about any person, and following a trader does not mean you will make money.</p>

<h2 id="legal">Legality is your responsibility</h2>
<p>Sports betting, daily fantasy and prediction markets are legal in some places and not others, and the rules change. You must be ${MIN_AGE} or older to use Line Reaper. It is your responsibility to make sure that any bet or trade you place is legal where you are and allowed by the platform you use.</p>

<h2 id="trademarks">Trademarks</h2>
<p>All third-party names and logos belong to their owners and are used only to identify them.</p>
`,
};

// ── Responsible gambling ──
PAGES['responsible-gambling'] = {
  title: 'Responsible Gambling',
  lead: 'Betting should be a choice you control. If it stops being fun, help is free, confidential and available every day.',
  body: c => `
<h2 id="help-now">Get help now (US)</h2>
<ul class="help">
<li><strong>National Problem Gambling Helpline: 1-800-GAMBLER</strong> (1-800-426-2537). Call or text, 24 hours a day, free and confidential. Run by the National Council on Problem Gambling, with online chat at <a href="https://www.ncpgambling.org/help-treatment/" rel="noopener">ncpgambling.org</a>.</li>
<li><strong>Gamblers Anonymous</strong>: meetings in person and online at <a href="https://www.gamblersanonymous.org" rel="noopener">gamblersanonymous.org</a>.</li>
<li><strong>Gam-Anon</strong>, for family and friends of someone with a gambling problem: <a href="https://www.gam-anon.org" rel="noopener">gam-anon.org</a>.</li>
<li><strong>988 Suicide and Crisis Lifeline</strong>: call or text <strong>988</strong> if you are in crisis or thinking about hurting yourself.</li>
</ul>

<h2 id="habits">Habits that keep betting under control</h2>
<ul>
<li>Set a bankroll you can afford to lose, separate from bill and savings money, and never top it up to chase losses.</li>
<li>Bet in fixed units. Line Reaper shows units so stakes stay small and steady.</li>
<li>Decide on time and money limits before you start, and use the deposit, loss and time limits your sportsbook or exchange offers.</li>
<li>Do not bet when you are upset, under pressure, or have been drinking.</li>
<li>Never borrow to bet, and never treat betting as a way to make a living or get out of debt.</li>
<li>Take regular breaks, and keep other hobbies and people in your life.</li>
</ul>

<h2 id="signs">Warning signs</h2>
<p>It may be time to get help if you:</p>
<ul>
<li>bet more than you planned, or more than you can afford;</li>
<li>chase losses, or feel you need to bet more to get the same excitement;</li>
<li>hide your betting, or lie about it to people close to you;</li>
<li>borrow money, sell things or miss bills because of betting;</li>
<li>feel anxious, irritable or low when you are not betting; or</li>
<li>keep trying to cut back and cannot.</li>
</ul>

<h2 id="tools">Blocking and self-exclusion</h2>
<ul>
<li><strong>Self-exclusion:</strong> most US states with legal betting run a self-exclusion list through their gaming regulator, and every licensed sportsbook and exchange lets you close or limit your own account.</li>
<li><strong>Blocking software:</strong> tools such as <a href="https://gamban.com" rel="noopener">Gamban</a> and <a href="https://betblocker.org" rel="noopener">BetBlocker</a> block gambling sites and apps on your devices.</li>
<li><strong>Bank blocks:</strong> many banks and card issuers let you block gambling transactions.</li>
</ul>

<h2 id="line-reaper">Taking a break from Line Reaper</h2>
<p>You can cancel Pro at any time from <em>Billing</em> and delete your account with <em>Delete account</em> at the bottom of the app. If you would like us to close your account and block your email from signing up again, email ${mail(c)} and we will do it. If you have excluded yourself from gambling, please do not use Line Reaper.</p>
<p>Line Reaper is only for people aged ${MIN_AGE} and over.</p>
`,
};

// ── Data sources and credits ──
PAGES['data-sources'] = {
  title: 'Data Sources and Credits',
  lead: 'Where the numbers come from. Line Reaper is not affiliated with or endorsed by any of these sources.',
  body: () => `
<h2 id="markets">Markets and odds</h2>
<ul>
<li><strong>Prediction markets and exchanges</strong>: public market data published by the exchanges and markets we cover. Where a source's terms need its permission for a paid service, its data is withheld from subscribers until that permission is in place.</li>
<li><strong>Sportsbook odds</strong>: aggregated odds providers, under their licence terms.</li>
</ul>

<h2 id="esports">Esports results and stats</h2>
<ul>
<li><strong>League of Legends</strong>: match and player data from <a href="https://lol.fandom.com" rel="noopener">Leaguepedia</a>, used under the <a href="https://creativecommons.org/licenses/by-sa/3.0/" rel="noopener">Creative Commons Attribution-ShareAlike licence</a>, and from <a href="https://oracleselixir.com" rel="noopener">Oracle's Elixir</a>.</li>
<li><strong>Dota 2</strong>: match data from the <a href="https://www.opendota.com" rel="noopener">OpenDota</a> API.</li>
<li><strong>Other titles</strong>: public results and statistics sources, where their terms allow.</li>
</ul>

<h2 id="trademarks">Trademarks</h2>
<p>League of Legends is a trademark of Riot Games, Inc. Dota 2 and Counter-Strike are trademarks of Valve Corporation. Valorant is a trademark of Riot Games, Inc. All other names and logos belong to their owners. Line Reaper is not endorsed by or affiliated with any of them.</p>

<h2 id="errors">Spotted a mistake?</h2>
<p>Data can be late or wrong. If you see something off, tell us and we will look into it.</p>
`,
};

const ORDER = ['terms', 'privacy', 'refunds', 'disclaimer', 'responsible-gambling', 'data-sources'];
const SHORT = { terms: 'Terms', privacy: 'Privacy', refunds: 'Refunds', disclaimer: 'Disclaimer', 'responsible-gambling': 'Responsible gambling', 'data-sources': 'Data sources' };

// ── the index ──
PAGES.legal = {
  title: 'Legal',
  lead: 'Everything that governs your use of Line Reaper, in one place.',
  body: c => `
<ul class="index">
${ORDER.map(k => `<li><a href="/${k}"><b>${esc(PAGES[k].title)}</b><span>${esc(PAGES[k].lead)}</span></a></li>`).join('\n')}
</ul>
<h2 id="contact">Contact</h2>
<p>${esc(c.operator)}<br>
Email: ${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'not published yet'}${c.address ? `<br>${esc(c.address)}` : ''}</p>
<p class="muted">Line Reaper is for people aged ${MIN_AGE} and over. If gambling is a problem for you or someone you know, call or text 1-800-GAMBLER.</p>
`,
};

const ALIASES = { tos: 'terms', 'terms-of-service': 'terms', 'privacy-policy': 'privacy', refund: 'refunds', 'refund-policy': 'refunds', 'responsible-gaming': 'responsible-gambling', 'data-credits': 'data-sources' };

const LOGO = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#10b981"/><path d="M8 24V8h3.4v13h6.6V24H8zm11-9.5h5V18h-5z" fill="#06110d"/><path d="M19 8h5v3.5h-5z" fill="#06110d" opacity=".55"/></svg>';
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2310b981'/%3E%3Cpath d='M8 24V8h3.4v13h6.6V24H8zm11-9.5h5V18h-5z' fill='%2306110d'/%3E%3C/svg%3E";

const CSS = `
:root { --bg:#ffffff; --text:#0f172a; --text2:#475569; --muted:#64748b; --border:#e2e8f0; --card:#f8fafc; --accent:#047857; --link:#047857; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b0f17; --text:#e5e7eb; --text2:#a3adbd; --muted:#7c8799; --border:#1f2937; --card:#111827; --accent:#10b981; --link:#34d399; } }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
a { color:var(--link); text-underline-offset:2px; }
.top { border-bottom:1px solid var(--border); }
.top-in, main, footer .in { max-width:760px; margin:0 auto; padding:0 20px; }
.top-in { display:flex; align-items:center; justify-content:space-between; height:60px; gap:12px; }
.brand { display:flex; align-items:center; gap:10px; color:var(--text); text-decoration:none; font-weight:700; letter-spacing:2.5px; font-size:13px; }
.brand b { font-weight:300; color:var(--text2); margin-left:4px; }
.back { font-size:14px; color:var(--text2); text-decoration:none; border:1px solid var(--border); border-radius:6px; padding:6px 12px; white-space:nowrap; }
.back:hover { color:var(--text); }
main { padding-top:40px; padding-bottom:56px; }
.kicker { font-size:12px; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
h1 { font-size:34px; line-height:1.15; letter-spacing:-.5px; margin:0 0 12px; }
.lead { color:var(--text2); font-size:17px; margin:0 0 8px; }
.dates { color:var(--muted); font-size:13px; margin:0 0 28px; }
nav.toc { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 18px; margin:0 0 32px; font-size:14px; }
nav.toc b { display:block; font-size:12px; letter-spacing:1.2px; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
nav.toc ol { margin:0; padding-left:20px; columns:2; column-gap:28px; }
nav.toc li { break-inside:avoid; }
h2 { font-size:20px; line-height:1.3; margin:36px 0 10px; scroll-margin-top:16px; }
p, ul { margin:0 0 14px; }
ul { padding-left:22px; }
li { margin:0 0 6px; }
table { width:100%; border-collapse:collapse; margin:0 0 16px; font-size:14px; }
th, td { text-align:left; vertical-align:top; padding:9px 10px; border-bottom:1px solid var(--border); }
th { font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--muted); }
ul.index { list-style:none; padding:0; border-top:1px solid var(--border); }
ul.index li { margin:0; border-bottom:1px solid var(--border); }
ul.index a { display:block; padding:16px 0; text-decoration:none; color:var(--text); }
ul.index b { display:block; font-size:17px; }
ul.index span { display:block; color:var(--text2); font-size:14px; margin-top:2px; }
ul.help li { margin-bottom:10px; }
.muted { color:var(--muted); font-size:14px; }
footer { border-top:1px solid var(--border); padding:24px 0 40px; font-size:13px; color:var(--muted); }
footer nav { display:flex; flex-wrap:wrap; gap:6px 18px; margin-bottom:10px; }
footer a { color:var(--text2); text-decoration:none; }
footer a:hover { color:var(--text); text-decoration:underline; }
@media (max-width:600px) { h1 { font-size:27px; } main { padding-top:28px; } nav.toc ol { columns:1; } .lead { font-size:16px; } table { font-size:13px; } th, td { padding:8px 6px; } }
@media print { .top, footer, nav.toc { display:none; } body { background:#fff; color:#000; } a { color:#000; } }
`;

function footerHtml() {
  return `<footer><div class="in"><nav>${ORDER.map(k => `<a href="/${k}">${esc(SHORT[k])}</a>`).join('')}<a href="/legal">All legal</a></nav>
<div>Line Reaper is an information service, not a sportsbook. ${MIN_AGE}+ only. Gambling problem? Call or text 1-800-GAMBLER.</div></div></footer>`;
}

function render(slug, cfg = configFromEnv()) {
  const key = ALIASES[slug] || slug;
  const page = PAGES[key];
  if (!page) return null;
  const body = page.body(cfg);
  const heads = [...body.matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)];
  const toc = key !== 'legal' && heads.length >= 5
    ? `<nav class="toc" aria-label="Contents"><b>Contents</b><ol>${heads.map(([, id, t]) => `<li><a href="#${id}">${t.replace(/^\d+\.\s*/, '')}</a></li>`).join('')}</ol></nav>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} | Line Reaper</title>
<meta name="description" content="${esc(page.lead)}">
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="top-in"><a class="brand" href="/legal">${LOGO}<span>LINE<b>REAPER</b></span></a><a class="back" href="/app">Open the app</a></div></header>
<main>
<p class="kicker">Legal</p>
<h1>${esc(page.title)}</h1>
<p class="lead">${esc(page.lead)}</p>
${key === 'legal' ? '' : `<p class="dates">Effective ${EFFECTIVE}. Last updated ${EFFECTIVE}.</p>`}
${toc}
${body}
</main>
${footerHtml()}
</body>
</html>`;
}

const slugs = () => [...Object.keys(PAGES), ...Object.keys(ALIASES)];

// Express wiring: GET /terms, /privacy, ... (and their aliases)
function mount(app, { env = process.env } = {}) {
  for (const slug of slugs()) {
    app.get(`/${slug}`, (req, res) => {
      const key = ALIASES[slug];
      if (key) return res.redirect(301, `/${key}`);
      res.set('Cache-Control', 'public, max-age=300').type('html').send(render(slug, configFromEnv(env)));
    });
  }
}

module.exports = { TERMS_VERSION, MIN_AGE, REFUND_HOURS, PAGES, ORDER, render, mount, configFromEnv, slugs };
