import { Check } from "lucide-react";
import { Link } from "react-router";
import { PLANS } from "./landing/content";
import { MarketingLayout, useCta } from "./landing/MarketingLayout";

/**
 * Pricing: free during the public beta, and what a director will pay at launch (the cast never
 * pays). Nothing can be bought yet, so every button signs up for the beta.
 */
export function Pricing() {
  const cta = useCta();
  return (
    <MarketingLayout path="/pricing">
      <header className="mk-hero mk-pricing-hero">
        <h1 className="mk-hero-title">Free during public beta.</h1>
        <p className="mk-hero-lede">After launch, the director pays per production. Your cast is always free.</p>
      </header>

      <section className="mk-section mk-pricing" aria-label="Plans">
        <ul className="mk-plans">
          {PLANS.map((plan) => (
            <li key={plan.name} className={`mk-plan ${plan.now ? "is-now raised" : "is-later"}`}>
              <div className="mk-plan-head">
                <h2>{plan.name}</h2>
                <span className={`mk-tag ${plan.now ? "is-now" : ""}`}>{plan.now ? "Available now" : "At launch"}</span>
              </div>
              <p className="mk-plan-price">
                {plan.was && (
                  <>
                    <s className="mk-plan-was" aria-label={`was ${plan.was}`}>
                      {plan.was}
                    </s>{" "}
                  </>
                )}
                <strong>{plan.price}</strong> <span className="muted">{plan.per}</span>
              </p>
              {plan.was && <p className="mk-founder small">Founder price: 50% off, locked in for life</p>}
              <p className="small muted">{plan.line}</p>
              <ul className="mk-plan-points small">
                <li>
                  <Check size={15} strokeWidth={2.5} aria-hidden="true" /> Cast always free, no accounts
                </li>
              </ul>
              <Link className={`btn ${plan.now ? "btn-primary" : "btn-secondary"}`} to={cta.to}>
                {cta.to === "/app" ? cta.label : plan.now ? cta.label : "Start free in the beta"}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mk-plans-note small muted">Free tier details coming after beta. Nothing is charged during the beta.</p>
      </section>
    </MarketingLayout>
  );
}
