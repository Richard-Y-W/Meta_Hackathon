# Optional future hardware bridge

Hardware is not needed for this software-only version. Keep `DEVICE_BRIDGE_URL` empty to use the virtual device.

The existing bridge adapter allows a later device server to implement:

```http
GET /observe
```

```json
{"observation":{"power":false,"direction":false,"motor":false}}
```

```http
POST /press
Content-Type: application/json

{"action":"A"}
```

The response must contain the same observation structure after the action settles. `A`, `B`, and `C` are the only accepted controls. The bridge must report measured output state, not commanded output state. No rule ID or internal mechanism should be returned. Requests time out after five seconds; an uncertain actuation outcome must be investigated before retrying a physical operation.

If enabled, the app labels the session `hardware bridge` and disables the simulated mutation action. That label means a bridge is configured, not that physical operation has independently been verified. Direct digital actuation is not robotic button pressing, and boolean telemetry is not visual grounding. Document those distinctions in any later physical demo.
