<?php
/**
 * Search form (searches products).
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;
$uid = wp_unique_id( 'sf-' );
?>
<form role="search" method="get" class="search-form" action="<?php echo esc_url( home_url( '/' ) ); ?>">
	<label class="screen-reader-text" for="<?php echo esc_attr( $uid ); ?>"><?php esc_html_e( 'Search products', 'mansu-rose' ); ?></label>
	<input type="search" id="<?php echo esc_attr( $uid ); ?>" name="s" value="<?php echo esc_attr( get_search_query() ); ?>" placeholder="<?php esc_attr_e( 'Search dresses, sets, colours…', 'mansu-rose' ); ?>" enterkeyhint="search">
	<input type="hidden" name="post_type" value="product">
	<button type="submit" class="btn-primary sm"><?php esc_html_e( 'Search', 'mansu-rose' ); ?></button>
</form>
