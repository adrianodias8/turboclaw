# PHP Patterns (Drupal Projects)

## Standards
- Follow Drupal coding standards (PSR-4 autoloading)
- Use strict types: `declare(strict_types=1)` in every file
- Type hints on all parameters and return types
- PHPDoc for complex types arrays/generics can't express

## Architecture
- Dependency injection via services — no static calls to Drupal::
- Use service containers; declare services in *.services.yml
- Thin controllers — business logic in services
- Repository pattern for data access

## Templates
- Twig only — no inline HTML in PHP
- Escape all variables: `{{ variable }}` auto-escapes
- Use `|raw` only when output is already sanitized
- Preprocess variables in theme hooks, not templates

## Database
- Use Drupal's database abstraction layer
- Never write raw SQL unless absolutely necessary
- Use entity queries for content, db_select for custom tables
- Always use placeholders for dynamic values

## Security
- CSRF tokens on all state-changing forms
- XSS: rely on Twig auto-escaping, use Xss::filter() in code
- Access checks in route definitions and controllers
- Validate file uploads (type, size, extension whitelist)
- Use Drupal's permission system — no custom auth

## Testing
- PHPUnit for unit tests, Kernel tests for services
- BrowserTestBase for functional tests
- Mock external services, never hit real APIs in tests
