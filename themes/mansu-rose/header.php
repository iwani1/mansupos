<?php
/**
 * Site header: notice bar, brand, search, account, bag, main navigation.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;
$wc       = class_exists( 'WooCommerce' );
$count    = $wc && WC()->cart ? WC()->cart->get_cart_contents_count() : 0;
$occasion = mansu_occasions();
$notices  = array_filter( array_map( 'trim', preg_split( '/\r\n|\r|\n/', (string) mansu_opt( 'notice' ) ) ) );
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="skip-link" href="#main"><?php esc_html_e( 'Skip to content', 'mansu-rose' ); ?></a>

<?php if ( $notices ) : ?>
<div class="notice-bar"><div class="wrap">
	<?php foreach ( $notices as $n ) : ?><span><?php echo esc_html( $n ); ?></span><?php endforeach; ?>
	<?php if ( mansu_wa_digits() ) : ?><span class="nb-wa"><?php echo esc_html( sprintf( /* translators: %s: phone */ __( 'WhatsApp %s', 'mansu-rose' ), mansu_opt( 'whatsapp' ) ) ); ?></span><?php endif; ?>
</div></div>
<?php endif; ?>

<header class="site-header">
	<div class="wrap bar">
		<button class="icon-btn menu-btn" type="button" data-open="menuD" aria-controls="menuD" aria-label="<?php esc_attr_e( 'Open menu', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'menu' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button>
		<?php if ( has_custom_logo() ) : ?>
			<div class="brand-logo"><?php the_custom_logo(); ?></div>
		<?php else : ?>
			<a class="brand" href="<?php echo esc_url( home_url( '/' ) ); ?>" rel="home"><?php echo esc_html( preg_replace( '/gh$/i', '', get_bloginfo( 'name' ) ) ); ?><small>gh</small></a>
		<?php endif; ?>
		<div class="tools">
			<button class="icon-btn" type="button" data-open="searchD" aria-controls="searchD" aria-label="<?php esc_attr_e( 'Search products', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'search' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button>
			<?php if ( $wc ) : ?>
				<a class="icon-btn hide-s" href="<?php echo esc_url( wc_get_page_permalink( 'myaccount' ) ); ?>" aria-label="<?php esc_attr_e( 'Your account', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'user' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></a>
				<?php if ( function_exists( 'YITH_WCWL' ) && method_exists( YITH_WCWL(), 'get_wishlist_url' ) ) : ?>
					<a class="icon-btn hide-s" href="<?php echo esc_url( YITH_WCWL()->get_wishlist_url() ); ?>" aria-label="<?php esc_attr_e( 'Wishlist', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'heart' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></a>
				<?php endif; ?>
				<a class="icon-btn bag-btn" href="<?php echo esc_url( wc_get_cart_url() ); ?>" data-open="bagD" aria-controls="bagD"><?php echo mansu_icon( 'bag' ); // phpcs:ignore WordPress.Security.EscapeOutput ?><span class="screen-reader-text"><?php esc_html_e( 'Bag, items:', 'mansu-rose' ); ?></span><span class="bag-count" aria-live="polite"><?php echo (int) $count; ?></span></a>
			<?php endif; ?>
		</div>
	</div>
	<nav class="main-nav" aria-label="<?php esc_attr_e( 'Main', 'mansu-rose' ); ?>">
		<div class="wrap nav-row">
			<?php
			wp_nav_menu(
				array(
					'theme_location' => 'primary',
					'container'      => false,
					'menu_class'     => 'menu',
					'depth'          => 1,
					'fallback_cb'    => 'mansu_menu_fallback',
				)
			);
			?>
			<?php if ( $occasion ) : ?>
				<button class="mega-btn" type="button" aria-expanded="false" aria-controls="mega"><?php esc_html_e( 'Occasions', 'mansu-rose' ); ?></button>
			<?php endif; ?>
		</div>
		<?php if ( $occasion ) : ?>
		<div class="mega" id="mega" hidden>
			<div class="wrap mega-in">
				<?php foreach ( $occasion as $o ) : ?>
					<a class="mega-tile" href="<?php echo esc_url( get_term_link( $o['term'] ) ); ?>">
						<?php
						if ( $o['image'] ) {
							echo wp_get_attachment_image( $o['image'], 'woocommerce_thumbnail', false, array( 'alt' => '', 'loading' => 'lazy' ) );
						}
						?>
						<span><b><?php echo esc_html( $o['label'] ); ?></b><small><?php echo esc_html( sprintf( /* translators: %d: count */ _n( '%d style', '%d styles', $o['term']->count, 'mansu-rose' ), $o['term']->count ) ); ?></small></span>
					</a>
				<?php endforeach; ?>
			</div>
		</div>
		<?php endif; ?>
	</nav>
</header>
