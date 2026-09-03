# LinkedIn Enterprise LangChain Tools

LangChain tools for LinkedIn organization pages: organization lookup, page posts, and creating an organization post.

Set `LINKEDIN_ENTERPRISE_ACCESS_TOKEN` for the default resolver, or call `setAuthResolver` to provide an encrypted-store or test credential source. `LINKEDIN_VERSION` optionally selects the LinkedIn REST API version and defaults to `202601`.

The token must belong to a member who is an administrator of the organization and must be approved for the LinkedIn organization and posting products. This package does not automate browser accounts or scrape LinkedIn.
