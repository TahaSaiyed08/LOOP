# Thesis chat: target answers for manual review

Hand-written examples of the style `thesisChat` should produce for a complete beginner. They are **targets to compare live Gemini answers against, not recorded outputs**. The thesis is the NVDA demo thesis from `npm run demo:chat`: $50 a month, 5 years, beginner, medium risk.
- Assumption 1: "Demand for NVIDIA AI data-center chips keeps growing…".
- Assumption 2: "NVDA does not suffer a large, lasting drop within 5 years".

The articles are the demo's hypothetical samples.

## 1. Simple educational question (no reminder, no sources)

> **You:** What is an ETF?
>
> **THESIS:** An ETF is a fund that lets you invest in a collection of companies instead of buying each one separately. Buying one share of an S&P 500 ETF, for example, gives you a small piece of about 500 large US companies at once.
>
> That matters for you because your thesis is built on one company, NVIDIA. With a single company, one bad year can hit your whole investment; an ETF spreads that risk out.

Check: the question is answered in the first sentence, the term is explained in plain words, the answer is tied to the user's own thesis, it's short, there's no closing reminder, and there are no citations.

## 2. Judgment question (direct assessment, one closing line)

> **You:** What are my weakest assumptions?
>
> **THESIS:** I think your second assumption is the most uncertain. It depends on NVIDIA's stock avoiding a big, lasting drop during your five-year timeline, and no one can know that in advance.
>
> A single company's price can move a lot, which is called volatility: how much an investment's price moves up and down. Five years is enough time for a broad fund to recover from many past drops, but one company can take longer, or not recover.
>
> Your first assumption, about demand for AI chips, is something you can watch over time through news and company results, so it's easier to check.
>
> This is my assessment based on your thesis, not a prediction. Check the evidence before making investment decisions.

Check: it picks one assumption and says why, explains a term once, invents no numbers or probabilities, and ends with exactly one reminder.

## 3. News investigation (attribution, warning sign vs lasting change)

> **You** (opened "Nvidia warns of slowing AI data-center orders" [hypothetical sample]): Does this article actually challenge my thesis?
>
> **THESIS:** Yes, it touches a warning sign you set for your first assumption. According to the article's summary, several large cloud customers are delaying chip orders, and NVIDIA lowered its revenue guidance, meaning its estimate of how much money it expects to bring in. [1]
>
> But one article doesn't show a lasting change. Delays for one quarter are different from demand shrinking for years, and your timeline is five years.
>
> You could look at NVIDIA's next earnings report to see whether orders pick up again.
>
> This is my assessment based on your thesis, not a prediction. Check the evidence before making investment decisions.
>
> [1] [HYPOTHETICAL SAMPLE] Nvidia warns of slowing AI data-center orders · Sample Wire (hypothetical example, not real news)

Check:
- It answers yes or no first.
- The claim is credited to the summary.
- "Matches a warning sign" is kept apart from "proves a lasting change".
- The earnings report is offered as a next step, not as something already read.

## 4. Headline-only evidence and missing evidence

> **You** (opened "Export limits could trim chip sales"): How serious is this?
>
> **THESIS:** It's hard to say from what we have. Based on the headline alone, new export rules could reduce some of NVIDIA's chip sales. [1] There's no summary, so I can't tell which countries, how much of NVIDIA's sales are affected, or when.
>
> For your thesis, this could matter to your first assumption about demand, but only if the limits are large and lasting. A useful next step would be finding a full news report on which sales the rules cover.
>
> This is my assessment based on your thesis, not a prediction. Check the evidence before making investment decisions.

Check: it says "headline alone", gives no invented details or numbers, and admits uncertainty plainly.

## Live review checklist (`npm run demo:chat`)

- [ ] Could someone with zero investing experience follow it after reading it once?
- [ ] Is the question answered in the first one or two sentences?
- [ ] Is each new term explained once, in plain words, and not again in later turns?
- [ ] Is it tied to this user's goal, timeline, investments and numbered assumptions?
- [ ] Do judgment questions get a clear pick plus reasoning, and exactly one closing reminder? Do ordinary questions get no reminder?
- [ ] Are there no invented prices, earnings, percentages or probabilities?
- [ ] Is every news claim attributed ("according to the summary…", "based on the headline alone…") with no doubled lead-in?
- [ ] Are research suggestions phrased as next steps, with no "I reviewed the report"?
- [ ] Are sample articles labelled `[HYPOTHETICAL SAMPLE]` in the list, the investigation and the citations?
