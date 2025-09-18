import "dotenv/config" // Load .env variables early (works in Node & Docker)
import express from "express"
import cors from "cors"
import type { Request as ExpressRequest, Response as ExpressResponse } from "express"

// Config from env
const {
    HYDRA_ADMIN_URL = "http://hydra:4445",
    KRATOS_PUBLIC_URL = "http://kratos:4433",
    AUTH_UI_ORIGIN = "https://auth.yourdomain.com", // your SPA origin
    BASE_PUBLIC_ORIGIN = "https://id.yourdomain.com", // where these routes are reachable
} = process.env

const app = express()
app.set("trust proxy", true)
app.use(express.json())

// CORS so the SPA at AUTH_UI_ORIGIN can call these routes with credentials
app.use(
    cors({
        origin: AUTH_UI_ORIGIN,
        credentials: true,
    })
)

// Health
app.get("/healthz", (_req: ExpressRequest, res: ExpressResponse) => res.status(200).send("ok"))

// Helpers
type KratosSession = { identity?: { id?: string } }
type HydraConsentRequest = {
    skip?: boolean
    requested_scope?: string[]
    client?: any
    requested_access_token_audience?: string[]
    subject?: string
}
type HydraAcceptResponse = { redirect_to: string }

const rp = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init)
    if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`${res.status} ${res.statusText}: ${body}`)
    }
    return res
}

const getJson = async <T>(res: globalThis.Response): Promise<T> => (await res.json()) as T

// GET /hydra/login?login_challenge=...
app.get("/hydra/login", async (req: ExpressRequest, res: ExpressResponse) => {
    const challenge = req.query.login_challenge as string
    if (!challenge) return res.status(400).send("missing login_challenge")

    try {
        // Is the user logged in with Kratos? Forward their cookies to whoami.
        const who = await fetch(`${KRATOS_PUBLIC_URL}/sessions/whoami`, {
            headers: { cookie: req.header("cookie") || "" },
        })

        if (who.status !== 200) {
            // Not authenticated -> redirect to Kratos login UI, and on success, come back here
            const returnTo = encodeURIComponent(`${BASE_PUBLIC_ORIGIN}/hydra/login?login_challenge=${encodeURIComponent(challenge)}`)
            const redirect = `${KRATOS_PUBLIC_URL}/self-service/login/browser?return_to=${returnTo}`
            return res.redirect(302, redirect)
        }

        // Get Hydra login request
        await rp(
            `${HYDRA_ADMIN_URL}/oauth2/auth/requests/login?login_challenge=${encodeURIComponent(
                challenge
            )}`
        )

        // Extract subject from Kratos (identity id)
        const session = await getJson<KratosSession>(who)
        const subject = session?.identity?.id
        if (!subject) return res.status(401).send("no session")

        // Accept login
        const acceptRes = await getJson<HydraAcceptResponse>(
            await rp(
                `${HYDRA_ADMIN_URL}/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(
                    challenge
                )}`,
                {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        subject,
                        remember: true,
                        remember_for: 60 * 60 * 24 * 30, // 30d
                    }),
                }
            )
        )

        return res.redirect(302, acceptRes.redirect_to)
    } catch (e: any) {
        console.error("login error", e.message)
        return res.status(500).send("login failed")
    }
})

// GET /hydra/consent?consent_challenge=...
// Redirects to your SPA consent page which will call POST /hydra/consent/accept|reject
app.get("/hydra/consent", async (req: ExpressRequest, res: ExpressResponse) => {
    const challenge = req.query.consent_challenge as string
    if (!challenge) return res.status(400).send("missing consent_challenge")

    try {
        const cr = await getJson<HydraConsentRequest>(
            await rp(
                `${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(
                    challenge
                )}`
            )
        )

        // If Hydra says skip, accept immediately with previously granted scopes.
        if (cr.skip) {
            const acceptRes = await getJson<HydraAcceptResponse>(
                await rp(
                    `${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(
                        challenge
                    )}`,
                    {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            grant_scope: cr.requested_scope,
                            remember: true,
                            remember_for: 60 * 60 * 24 * 30,
                            session: {
                                id_token: {},
                            },
                        }),
                    }
                )
            )
            return res.redirect(302, acceptRes.redirect_to)
        }

        // No skip -> redirect browser to SPA Consent UI
        const to = `${AUTH_UI_ORIGIN}/consent?consent_challenge=${encodeURIComponent(challenge)}`
        return res.redirect(302, to)
    } catch (e: any) {
        console.error("consent init error", e.message)
        return res.status(500).send("consent init failed")
    }
})

// API for SPA to load consent details
app.get("/hydra/consent/details", async (req: ExpressRequest, res: ExpressResponse) => {
    const challenge = req.query.consent_challenge as string
    if (!challenge) return res.status(400).json({ error: "missing consent_challenge" })
    try {
        const cr = await getJson<HydraConsentRequest>(
            await rp(
                `${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(
                    challenge
                )}`
            )
        )
        return res.json({
            requested_scope: cr.requested_scope,
            client: cr.client,
            requested_access_token_audience: cr.requested_access_token_audience,
            subject: cr.subject,
        })
    } catch (e: any) {
        console.error("consent details error", e.message)
        return res.status(500).json({ error: "failed" })
    }
})

// Accept consent
app.post("/hydra/consent/accept", async (req: ExpressRequest, res: ExpressResponse) => {
    const { consent_challenge, grant_scope = [], id_token = {} } = req.body || {}
    if (!consent_challenge) return res.status(400).json({ error: "missing consent_challenge" })
    try {
        const acceptRes = await getJson<HydraAcceptResponse>(
            await rp(
                `${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(
                    consent_challenge
                )}`,
                {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        grant_scope,
                        remember: true,
                        remember_for: 60 * 60 * 24 * 30,
                        session: { id_token },
                    }),
                }
            )
        )
        return res.json({ redirect_to: (acceptRes as HydraAcceptResponse).redirect_to })
    } catch (e: any) {
        console.error("consent accept error", e.message)
        return res.status(500).json({ error: "failed" })
    }
})

// Reject consent
app.post("/hydra/consent/reject", async (req: ExpressRequest, res: ExpressResponse) => {
    const { consent_challenge, error = "access_denied", error_description = "The resource owner denied the request" } = req.body || {}
    if (!consent_challenge) return res.status(400).json({ error: "missing consent_challenge" })
    try {
        const rejRes = await getJson<HydraAcceptResponse>(
            await rp(
                `${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent/reject?consent_challenge=${encodeURIComponent(
                    consent_challenge
                )}`,
                {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ error, error_description }),
                }
            )
        )
        return res.json({ redirect_to: rejRes.redirect_to })
    } catch (e: any) {
        console.error("consent reject error", e.message)
        return res.status(500).json({ error: "failed" })
    }
})

// GET /hydra/logout?logout_challenge=...
app.get("/hydra/logout", async (req: ExpressRequest, res: ExpressResponse) => {
    const challenge = req.query.logout_challenge as string
    if (!challenge) return res.status(400).send("missing logout_challenge")
    try {
        await rp(
            `${HYDRA_ADMIN_URL}/oauth2/auth/requests/logout?logout_challenge=${encodeURIComponent(
                challenge
            )}`
        )
        // Optional: also revoke Kratos session here by calling /self-service/logout/browser (requires browser redirect) or Admin API if you expose it internally.
        const acc = await getJson<HydraAcceptResponse>(
            await rp(
                `${HYDRA_ADMIN_URL}/oauth2/auth/requests/logout/accept?logout_challenge=${encodeURIComponent(
                    challenge
                )}`,
                {
                    method: "PUT",
                }
            )
        )
        return res.redirect(302, (acc as HydraAcceptResponse).redirect_to)
    } catch (e: any) {
        console.error("logout error", e.message)
        return res.status(500).send("logout failed")
    }
})

const port = Number(process.env.PORT) || 8080
app.listen(port, () => {
    console.log(
        `hydra-bridge listening on ${port} (env: HYDRA_ADMIN_URL=${process.env.HYDRA_ADMIN_URL}, KRATOS_PUBLIC_URL=${process.env.KRATOS_PUBLIC_URL})`
    )
})