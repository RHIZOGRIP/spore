import providers, { billingOf } from 'mohdel/providers'

/**
 * How the model's calls are paid for, as mohdel declares it, or null for a provider mohdel does
 * not know: a definition is written by hand, and a spore naming one is still shown.
 */
export const billingFor = (model) => (Object.hasOwn(providers, model.split('/')[0]) ? billingOf(model) : null)

/** True when the model's calls carry no per-call price — a subscription — so spending nothing is not free. */
export const unmetered = (billing) => billing !== null && billing.kind !== 'metered'
