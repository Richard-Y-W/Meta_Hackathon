# LIFELINE: three-minute pitch script

Every number on screen comes from a recorded run (`artifacts/lifeline/v2/run-0/storylines.json`, live Meta brain). Every outside fact has a source listed at the end. **[Production notes are in brackets.]**

## 0:00 – 0:25 · The threat

> In 2023, hackers working for Iran's Revolutionary Guard broke into the control systems of American water utilities. Last year the NSA, CISA and the FBI warned that Iranian actors may target U.S. networks, and this year they warned again: water and energy.
>
> Cyber attacks, storms, a tree on a line. When the power goes…

**[switch-slip audio · lights cut · two seconds of black · heartbeat]**

> …a hospital's water pumps stop with it.

## 0:25 – 0:40 · The answer

> LIFELINE kept that hospital running.
>
> LIFELINE detects emerging threats, predicts how failures could spread, and coordinates interventions that preserve essential services across power, water, communications and other infrastructure.

## 0:40 – 1:20 · How it works: think slow, act fast

**[architecture graphic: warning signs → Muse brain → physics check → armed town]**

> At its core is Meta's Muse model, used as LIFELINE's brain.
>
> Muse does what no control system can: it reads the warning signs people write. A security team's intrusion alert, a crew's radio note about a tree leaning on a line, a weather bulletin. It turns them into specific threats: *this line, in this window, this confident, because of this report.*
>
> Then LIFELINE checks every idea against physics. It simulates the town's coupled power, water and communications networks to predict exactly how the failure would spread. The line drops, the pump station goes dark, and the hospital's water runs out an hour later.
>
> It takes action only when the simulation proves the action helps, and does no harm if the threat never comes. Whatever it can't do in advance, it arms as a reflex that fires the instant the failure hits.
>
> The AI thinks before the crisis. When the crisis arrives, the town is already armed.

## 1:20 – 2:15 · The demonstration (live)

**[screen: LIFELINE operations view, scenario "Cyber intrusion on the ridge feeder"]**

> The security team reports an intruder probing the remote control of the recloser feeding the north ridge line. Muse reads the alert and flags that line as threatened. It cites the report and gives a confidence.
>
> LIFELINE predicts the spread. The pump station loses power, the water tower drains, and the hospital loses water.
>
> It finds the fix: close the tie that back-feeds the ridge from the other substation. It proves in simulation that the fix works if the attack comes and is harmless if it doesn't, and acts.
>
> The attacker opens the recloser. **[the line goes red on the map]** The hospital never notices.

**[cut to results table]**

> Same faults, same town, three controllers. In the storm, conventional control lost 312 MJ of essential power, and LIFELINE lost none. Storm plus a second failure: 528 against 14. A sudden failure with jammed switches: 273 against 78. And when the warning was a false alarm, LIFELINE did no harm.

## 2:15 – 2:40 · It scales

**[toggle the map to Water]**

> It's the same brain, the same physics check and the same reflexes. Here is the water network: pumps, the tower and hospital delivery. Each new infrastructure plugs in through its own simulator and its own actions, and LIFELINE coordinates across all of them.

## 2:40 – 3:00 · Close

> We also tested putting AI directly in the control loop. It was too slow and added nothing, so we built LIFELINE to think before the failure instead.
>
> We can't prevent cyber attacks. But we can give our critical infrastructure a lifeline.

---

## What may and may not be said

- **Say:** the measured numbers from the results table, attributed to "our simulated town" (recorded run: `docs/results/lifeline-v2-run-0.json`). The cyber scenario has no recorded live-brain run yet; show it live instead of quoting numbers.
- **Don't say:** "saves millions of dollars", "30 seconds faster on average", or that LIFELINE detects cyber intrusions. It reads the security team's alerts and protects services against the attack's effects.
- **If asked whether this is real:** it is a working system on a physics-simulated town (a CIGRE benchmark feeder in pandapower, an EPANET water network, modeled communications), not a deployment.

## Sources

- CISA, *IRGC-Affiliated Cyber Actors Exploit PLCs in Multiple Sectors, Including U.S. Water and Wastewater Systems Facilities* (AA23-335A, Dec 2023): https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-335a
- NSA/CISA/FBI/DC3, *Iranian Cyber Actors May Target Vulnerable U.S. Networks and Entities of Interest* (June 30, 2025): https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4229506/nsa-cisa-fbi-and-dc3-warn-iranian-cyber-actors-may-target-vulnerable-us-network/
- Cybersecurity Dive, *Iran-linked hackers target water, energy in US, FBI and CISA warn* (2026): https://www.cybersecuritydive.com/news/iran-linked-hackers-targeting-water-energy-in-us-fbi-and-cisa-warn/816949/
