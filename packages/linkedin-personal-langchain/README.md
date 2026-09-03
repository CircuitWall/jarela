# LinkedIn Personal LangChain Tools

LangChain tools for the authenticated LinkedIn member: profile identity, member posts, and creating a text post.

Set `LINKEDIN_PERSONAL_ACCESS_TOKEN` for the default resolver, or call `setAuthResolver` to provide an encrypted-store or test credential source. `LINKEDIN_VERSION` optionally selects the LinkedIn REST API version and defaults to `202601`.

The token must be approved for the LinkedIn products and scopes required by the requested operation. This package does not scrape LinkedIn or access other members' private data.
