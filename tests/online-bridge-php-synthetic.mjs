// Optional REAL PHP interpreter smoke tests for the bridge's PHP functions.
// Requires an ignored, local-only npm install under test-results/phase2-php-runtime.
// Not WordPress, WooCommerce, MySQL, HPOS, stock-lock or gateway evidence.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('test-results/phase2-php-runtime/node_modules');
if (!fs.existsSync(root)) {
  console.error('Install the ignored local PHP runtime first: npm install --no-save --no-package-lock --ignore-scripts --prefix test-results/phase2-php-runtime @php-wasm/node@3.1.64');
  process.exit(2);
}
const { PHP } = await import(pathToFileURL(`${root}/@php-wasm/universal/index.js`));
const { loadNodeRuntime } = await import(pathToFileURL(`${root}/@php-wasm/node/index.js`));
const source = fs.readFileSync('woocommerce/mansu-online-bridge/mansu-online-bridge.php', 'utf8').replace(/^<\?php/, '');
const prelude = String.raw`<?php
namespace {
const ABSPATH = '/synthetic/';
const MANSU_ONLINE_BRIDGE_ENABLED = true;
const MANSU_ONLINE_BRIDGE_SERVICE = 'staging';
const MANSU_ONLINE_BRIDGE_LEDGER_ID = 'ba0c917e-6278-4aaf-b89d-d87f39a39762';
const MANSU_ONLINE_BRIDGE_SITE_ID = '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const MANSU_ONLINE_BRIDGE_SECRET = 'only-local-synthetic-secret-for-test-fixtures';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$GLOBALS['local'] = true;
$GLOBALS['cap'] = true;
$GLOBALS['tax'] = false;
function register_activation_hook( $file, $action ) {}
function add_action( $name, $callback, $priority = 10, $args = 1 ) {}
function wp_get_environment_type() { return $GLOBALS['local'] ? 'local' : 'production'; }
function current_user_can( $cap ) { return $cap === 'mansu_online_bridge' && $GLOBALS['cap']; }
function is_ssl() { return false; }
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function wp_json_encode( $value ) { return json_encode( $value ); }
function wc_tax_enabled() { return $GLOBALS['tax']; }
class WP_Error {
  public function __construct( public $code, public $message, public $data ) {}
}
class FakeRequest {
  private $headers = array();
  public function __construct( private $method, private $route, private $body ) {}
  public function set_header( $name, $value ) { $this->headers[ strtolower( $name ) ] = $value; }
  public function get_header( $name ) { return $this->headers[ strtolower( $name ) ] ?? ''; }
  public function get_body() { return $this->body; }
  public function get_method() { return $this->method; }
  public function get_route() { return $this->route; }
  public function get_json_params() { return json_decode( $this->body, true ); }
}
class FakeProduct {
  public function __construct( private $id, private $kind, private $owner, private $quantity = 1, private $price = '100.00' ) {}
  public function is_type( $type ) { return $this->kind === $type; }
  public function get_parent_id() { return $this->kind === 'variation' ? 10 : 0; }
  public function get_status() { return 'publish'; }
  public function is_purchasable() { return true; }
  public function is_in_stock() { return $this->quantity > 0; }
  public function is_virtual() { return false; }
  public function is_downloadable() { return false; }
  public function backorders_allowed() { return false; }
  public function is_sold_individually() { return false; }
  public function get_price() { return $this->price; }
  public function get_sku() { return $this->kind === 'variation' ? 'VAR-11' : 'PARENT'; }
  public function get_stock_managed_by_id() { return $this->owner; }
  public function managing_stock() { return true; }
  public function get_stock_quantity() { return $this->quantity; }
}
$GLOBALS['parent'] = new FakeProduct( 10, 'variable', 10 );
$GLOBALS['child'] = new FakeProduct( 11, 'variation', 10 );
function wc_get_product( $id ) { return $id === 10 ? $GLOBALS['parent'] : ( $id === 11 ? $GLOBALS['child'] : false ); }
function check( $condition, $message ) {
  $GLOBALS['checks'] = ( $GLOBALS['checks'] ?? 0 ) + 1;
  if ( ! $condition ) { throw new \RuntimeException( $message ); }
}
`;
const checks = String.raw`
check( mansu_online_enabled(), 'local flag failed' );
check( mansu_online_money( '1.90' ) === 190, 'money conversion' );
check( mansu_online_money( '1.999' ) === -1, 'ambiguous money accepted' );
check( mansu_online_uuid( MANSU_ONLINE_BRIDGE_LEDGER_ID ), 'UUID validation' );
$input = array(
  'service' => 'staging', 'ledgerId' => MANSU_ONLINE_BRIDGE_LEDGER_ID,
  'key' => 'fb89eb6f-4cd5-4777-87a4-e49bfb978b81', 'fingerprint' => str_repeat( 'a', 64 ),
  'cashierId' => 'a9a0e559-818e-444f-9cd6-99ee5f3e11da',
  'shiftId' => '98df372a-2586-460f-b8a2-5b56dc79666d', 'saleType' => 'retail',
  'items' => array( array( 'productId' => 10, 'variationId' => 11, 'quantity' => 1,
    'expectedUnitCents' => 10000, 'ownerId' => 10, 'sku' => 'VAR-11' ) )
);
$route = '/mansu-pos/v1/attempts';
$body = json_encode( $input );
$request = new FakeRequest( 'POST', $route, $body );
$timestamp = strval( time() );
$request->set_header( 'x-mansu-bridge-timestamp', $timestamp );
$request->set_header( 'x-mansu-bridge-signature', hash_hmac( 'sha256', $timestamp . "\nPOST\n" . $route . "\n" . hash( 'sha256', $body ), MANSU_ONLINE_BRIDGE_SECRET ) );
check( mansu_online_permission( $request ) === true, 'signed service request refused' );
check( ! is_wp_error( mansu_online_input( $request ) ), 'valid cart refused' );
check( ! is_wp_error( mansu_online_products( $input ) ), 'shared parent-owned variation refused' );
$altered = $input; $altered['items'][0]['ownerId'] = 11;
check( is_wp_error( mansu_online_products( $altered ) ), 'wrong stock owner accepted' );
$altered = $input; $altered['items'][0]['quantity'] = 2;
check( is_wp_error( mansu_online_products( $altered ) ), 'insufficient pool accepted' );
$altered = $input; $altered['items'][0]['expectedUnitCents'] = 9900;
check( is_wp_error( mansu_online_products( $altered ) ), 'stale catalogue price accepted' );
$altered = $input; $altered['items'][0]['sku'] = 'OTHER';
check( is_wp_error( mansu_online_products( $altered ) ), 'edited variation SKU accepted' );
$altered = $input; $altered['ledgerId'] = '1a0c917e-6278-4aaf-b89d-d87f39a39762';
check( is_wp_error( mansu_online_input( new FakeRequest( 'POST', $route, json_encode( $altered ) ) ) ), 'wrong ledger accepted' );
$altered = $input; $altered['items'][0]['agreedUnitCents'] = 7200;
check( is_wp_error( mansu_online_input( new FakeRequest( 'POST', $route, json_encode( $altered ) ) ) ), 'retail negotiated price accepted' );
$altered = $input; $altered['saleType'] = 'wholesale';
$altered['items'][0]['agreedUnitCents'] = 7200;
$altered['quoteHash'] = str_repeat( 'b', 64 );
$altered['approvedBy'] = $altered['cashierId'];
$altered['approvedAt'] = '2026-11-14T03:00:00.000Z';
$altered['buyerId'] = ''; $altered['buyerName'] = 'Synthetic Buyer';
$GLOBALS['tax'] = true;
check( is_wp_error( mansu_online_input( new FakeRequest( 'POST', $route, json_encode( $altered ) ) ) ), 'unverified wholesale tax accepted' );
$GLOBALS['tax'] = false;
check( ! is_wp_error( mansu_online_input( new FakeRequest( 'POST', $route, json_encode( $altered ) ) ) ), 'tax-free quote refused' );
$request->set_header( 'x-mansu-bridge-signature', str_repeat( '0', 64 ) );
check( is_wp_error( mansu_online_permission( $request ) ), 'bad HMAC accepted' );
$GLOBALS['local'] = false;
check( is_wp_error( mansu_online_permission( $request ) ), 'production flag accepted' );
$GLOBALS['local'] = true;
$GLOBALS['cap'] = false;
check( is_wp_error( mansu_online_permission( $request ) ), 'service without custom capability accepted' );
echo 'PHP_SYNTHETIC_OK ' . $GLOBALS['checks'] . " checks on PHP " . PHP_VERSION . "\n";
}
`;
let exit = 1;
try {
  // processId is mandatory in recent php-wasm; do not rely on a default that
  // could collide when multiple runtimes share locks.
  const php = new PHP(await loadNodeRuntime('8.2', { emscriptenOptions: { processId: 70201 } }));
  const result = await php.runStream({ code: prelude + source + checks });
  const stdout = await result.stdoutText;
  const stderr = await result.stderrText;
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  exit = stdout.includes('PHP_SYNTHETIC_OK 18 checks') && !stderr ? 0 : 1;
} catch (error) { console.error(error); }
// The runtime keeps internal async workers alive on Node 22; close this
// standalone synthetic probe explicitly, never a long-running server.
process.exit(exit);
