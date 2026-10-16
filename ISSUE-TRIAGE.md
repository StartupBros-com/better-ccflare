# Issue triage automation retired

This branch removes the inherited automatic Issue Triage Agent workflow and its
exclusively used script. See [PR #434](https://github.com/StartupBros-com/better-ccflare/pull/434)
for the removal and its review status. The removal takes effect for newly opened
issues only after it is merged into the default branch; a draft PR does not disable
the bot running from main.

The retired workflow sent issue content to an external model endpoint and could
apply labels and post comments. Its former setup, model pricing, and testing
instructions no longer apply to this source tree. Do not create a test issue or
configure model credentials to validate this removal: inspect the workflow files
and CI results instead.

Other CI, review workflows, release automation, and upstream monitoring remain
separate and are not disabled by this change. This notice does not claim that all
repository automation or external model calls have been removed.
