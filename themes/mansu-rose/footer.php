<?php
/**
 * Site footer and the dialogs every page can open (bag, search, quick view, menu).
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;
$wc = class_exists( 'WooCommerce' );
?>
<footer class="site-footer">
	<div class="wrap foot">
		<div class="foot-brand">
			<a class="brand" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php echo esc_html( preg_replace( '/gh$/i', '', get_bloginfo( 'name' ) ) ); ?><small>gh</small></a>
			<address>
				<?php echo esc_html( mansu_opt( 'address' ) ); ?><br>
				<?php echo esc_html( trim( mansu_opt( 'whatsapp' ) . ( mansu_opt( 'phone2' ) ? ' · ' . mansu_opt( 'phone2' ) : '' ) ) ); ?><br>
				<?php echo esc_html( mansu_opt( 'email' ) ); ?>
			</address>
		</div>
		<?php if ( $wc && mansu_featured_cats() ) : ?>
		<nav aria-label="<?php esc_attr_e( 'Shop', 'mansu-rose' ); ?>">
			<h2><?php esc_html_e( 'Shop', 'mansu-rose' ); ?></h2>
			<ul>
				<li><a href="<?php echo esc_url( add_query_arg( 'orderby', 'date', wc_get_page_permalink( 'shop' ) ) ); ?>"><?php esc_html_e( 'New in', 'mansu-rose' ); ?></a></li>
				<?php foreach ( mansu_featured_cats() as $t ) : ?>
					<li><a href="<?php echo esc_url( get_term_link( $t ) ); ?>"><?php echo esc_html( $t->name ); ?></a></li>
				<?php endforeach; ?>
			</ul>
		</nav>
		<?php endif; ?>
		<?php if ( mansu_occasions() ) : ?>
		<nav aria-label="<?php esc_attr_e( 'Occasions', 'mansu-rose' ); ?>">
			<h2><?php esc_html_e( 'Occasions', 'mansu-rose' ); ?></h2>
			<ul>
				<?php foreach ( mansu_occasions() as $o ) : ?>
					<li><a href="<?php echo esc_url( get_term_link( $o['term'] ) ); ?>"><?php echo esc_html( $o['label'] ); ?></a></li>
				<?php endforeach; ?>
			</ul>
		</nav>
		<?php endif; ?>
		<nav aria-label="<?php esc_attr_e( 'Help', 'mansu-rose' ); ?>">
			<h2><?php esc_html_e( 'Help', 'mansu-rose' ); ?></h2>
			<?php
			if ( has_nav_menu( 'footer' ) ) {
				wp_nav_menu( array( 'theme_location' => 'footer', 'container' => false, 'depth' => 1 ) );
			} else {
				echo '<ul>';
				if ( $wc ) {
					echo '<li><a href="' . esc_url( wc_get_page_permalink( 'myaccount' ) ) . '">' . esc_html__( 'Your account', 'mansu-rose' ) . '</a></li>';
					echo '<li><a href="' . esc_url( wc_get_cart_url() ) . '">' . esc_html__( 'Your bag', 'mansu-rose' ) . '</a></li>';
				}
				echo '<li><a href="' . esc_url( mansu_wa_link() ) . '" target="_blank" rel="noopener">' . esc_html__( 'Order on WhatsApp', 'mansu-rose' ) . '</a></li>';
				echo '</ul>';
			}
			?>
		</nav>
		<div class="legal">
			<span>
			<?php
			/* translators: 1: year, 2: site name */
			echo esc_html( sprintf( __( '© %1$s %2$s. Women\'s clothing, wholesale & retail, Accra.', 'mansu-rose' ), gmdate( 'Y' ), get_bloginfo( 'name' ) ) );
			?>
			</span>
			<?php if ( function_exists( 'get_privacy_policy_url' ) && get_privacy_policy_url() ) : ?>
				<a href="<?php echo esc_url( get_privacy_policy_url() ); ?>"><?php esc_html_e( 'Privacy policy', 'mansu-rose' ); ?></a>
			<?php endif; ?>
		</div>
	</div>
</footer>

<?php if ( $wc ) : ?>
<dialog class="side" id="bagD" aria-labelledby="bagH">
	<div class="side-head"><h2 id="bagH"><?php esc_html_e( 'Your bag', 'mansu-rose' ); ?></h2><button class="icon-btn" type="button" data-close aria-label="<?php esc_attr_e( 'Close bag', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'close' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button></div>
	<div class="side-body"><div class="widget_shopping_cart_content"><?php woocommerce_mini_cart(); ?></div></div>
	<div class="side-foot">
		<a class="btn-ghost bag-wa" href="<?php echo esc_url( mansu_cart_wa_link() ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Order on WhatsApp', 'mansu-rose' ); ?></a>
		<small><?php esc_html_e( 'Delivery cost for your area is confirmed at checkout or on WhatsApp.', 'mansu-rose' ); ?></small>
	</div>
</dialog>
<dialog class="qv-d" id="qvD" aria-labelledby="qv-title"><div class="qv-body"></div></dialog>
<?php endif; ?>

<dialog class="search-d" id="searchD" aria-label="<?php esc_attr_e( 'Search', 'mansu-rose' ); ?>">
	<div class="search-in">
		<form class="search-row" role="search" method="get" action="<?php echo esc_url( home_url( '/' ) ); ?>">
			<label class="screen-reader-text" for="q"><?php esc_html_e( 'Search products', 'mansu-rose' ); ?></label>
			<input id="q" type="search" name="s" placeholder="<?php esc_attr_e( 'Search dresses, sets, colours…', 'mansu-rose' ); ?>" autocomplete="off" enterkeyhint="search">
			<input type="hidden" name="post_type" value="product">
			<button class="icon-btn" type="button" data-close aria-label="<?php esc_attr_e( 'Close search', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'close' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button>
		</form>
		<div class="pop">
			<span class="eyebrow"><?php esc_html_e( 'Popular', 'mansu-rose' ); ?></span>
			<?php foreach ( array( __( 'Two-piece set', 'mansu-rose' ), __( 'Shirt dress', 'mansu-rose' ), __( 'Yellow', 'mansu-rose' ), __( 'Wide-leg pant', 'mansu-rose' ), __( 'Kaftan', 'mansu-rose' ) ) as $p ) : ?>
				<button class="pill" type="button" data-pop="<?php echo esc_attr( $p ); ?>"><?php echo esc_html( $p ); ?></button>
			<?php endforeach; ?>
		</div>
		<p class="s-info" aria-live="polite"></p>
		<div class="s-cats"></div>
		<div class="sugg"></div>
	</div>
</dialog>

<dialog class="side left" id="menuD" aria-label="<?php esc_attr_e( 'Menu', 'mansu-rose' ); ?>">
	<div class="side-head"><span class="brand"><?php echo esc_html( preg_replace( '/gh$/i', '', get_bloginfo( 'name' ) ) ); ?><small>gh</small></span><button class="icon-btn" type="button" data-close aria-label="<?php esc_attr_e( 'Close menu', 'mansu-rose' ); ?>"><?php echo mansu_icon( 'close' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button></div>
	<div class="side-body mob-nav">
		<?php get_search_form(); ?>
		<?php wp_nav_menu( array( 'theme_location' => 'primary', 'container' => false, 'depth' => 1, 'fallback_cb' => 'mansu_menu_fallback' ) ); ?>
		<?php if ( mansu_occasions() ) : ?>
			<p class="eyebrow"><?php esc_html_e( 'Occasions', 'mansu-rose' ); ?></p>
			<ul class="menu">
				<?php foreach ( mansu_occasions() as $o ) : ?>
					<li><a href="<?php echo esc_url( get_term_link( $o['term'] ) ); ?>"><?php echo esc_html( $o['label'] ); ?></a></li>
				<?php endforeach; ?>
			</ul>
		<?php endif; ?>
		<?php if ( $wc ) : ?>
			<p><a class="link-u" href="<?php echo esc_url( wc_get_page_permalink( 'myaccount' ) ); ?>"><?php esc_html_e( 'Your account', 'mansu-rose' ); ?></a></p>
		<?php endif; ?>
	</div>
</dialog>

<div class="toast" id="toast" role="status" aria-live="polite"><span class="toast-t"></span><button type="button" data-open="bagD"><?php esc_html_e( 'View bag', 'mansu-rose' ); ?></button></div>
<?php wp_footer(); ?>
</body>
</html>
